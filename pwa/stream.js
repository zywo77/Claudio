/**
 * Claudio — SSE 流式客户端
 * 1. fetch + ReadableStream 连接 POST /api/chat
 * 2. 逐字跳出的打字机动画
 * 3. 收到播放指令时自动更新封面 + 播放音频
 */

class ClaudioStream {
  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
    this.controller = null;
    this.typewriter = new Typewriter();
    this._audioEl = null;
    // 情绪标签缓冲区
    this._moodBuffer = '';
    this._onMoodCallback = null;
  }

  /** 绑定 DOM（由 index.html 初始化时调用） */
  bind({ audio }) {
    this._audioEl = audio;
  }

  /**
   * 发送消息，SSE 流式接收
   * callbacks:
   *   onChar(char)        — 每跳出一个字符
   *   onToolCalls(names)  — 模型调用工具
   *   onToolResult(obj)   — 工具返回
   *   onPlay(song)        — 播放指令
   *   onDone()            — 流结束
   *   onError(err)        — 出错
   */
  async send(message, callbacks = {}) {
    this.abort();
    this.typewriter.clear();
    this.controller = new AbortController();

    const { onChar, onToolCalls, onToolResult, onPlay, onMood, onDone, onError } = callbacks;

    // 重置情绪标签缓冲
    this._moodBuffer = '';
    this._onMoodCallback = onMood;

    // 启动打字机：回调绑定
    this.typewriter.start((ch) => {
      onChar?.(ch);
    });

    try {
      const resp = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, source: 'chat' }),
        signal: this.controller.signal,
      });

      if (!resp.ok) {
        onError?.(`HTTP ${resp.status}: ${await resp.text()}`);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data: ')) continue;

          let event;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          switch (event.type) {
            case 'text':
              // 过滤情绪标签后送入打字机
              const filtered = this._filterMoodTag(event.content);
              if (filtered) this.typewriter.enqueue(filtered);
              break;

            case 'tool_calls':
              onToolCalls?.(event.calls || []);
              break;

            case 'tool_result':
              onToolResult?.({ name: event.name, result: event.result });
              // 自动处理音乐播放（歌词辨认场景跳过）
              if (event.context !== 'lyric_guess' && (event.name === 'search_music' || event.name === 'recommend_music' || event.name === 'search_favorites')) {
                try { this._handleMusicResult(event.result, onPlay); } catch (e) { console.error('[stream] music result error:', e); }
              }
              break;

            case 'done':
              // 等打字机排空再回调
              this.typewriter.flush(() => onDone?.());
              return;

            case 'error':
              this.typewriter.clear();
              onError?.(event.error || '未知错误');
              return;
          }
        }
      }
      this.typewriter.flush(() => onDone?.());
    } catch (e) {
      this.typewriter.clear();
      if (e.name !== 'AbortError') onError?.(e.message);
    } finally {
      this.controller = null;
    }
  }

  /** 中止当前请求 */
  abort() {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    this.typewriter.clear();
    this._moodBuffer = '';
  }

  /**
   * 过滤情绪标签 [mood:xxx]
   * 流式输出时标签会被拆成多个 chunk，需要缓冲处理
   */
  _filterMoodTag(text) {
    // 累加到缓冲区
    this._moodBuffer += text;

    // 循环处理所有完整的标签
    while (true) {
      const moodMatch = this._moodBuffer.match(/\[mood:(sad|anxious|calm|happy|melancholy|energetic)\]\s*/);

      if (moodMatch) {
        // 完整标签已匹配，提取情绪
        const mood = moodMatch[1];
        // 移除标签
        this._moodBuffer = this._moodBuffer.replace(moodMatch[0], '');
        // 触发情绪回调
        if (this._onMoodCallback) this._onMoodCallback(mood);
        continue; // 继续检查是否有更多标签
      }

      // 检查缓冲区末尾是否可能是标签的开头（如 "[mood:" 后面还没写完）
      if (this._moodBuffer.match(/\[mood:([a-z]*)$/)) {
        // 可能是标签的一部分，继续缓冲
        return null;
      }

      break;
    }

    // 输出缓冲区内容
    if (this._moodBuffer.length > 0) {
      const output = this._moodBuffer;
      this._moodBuffer = '';
      return output;
    }

    return null;
  }

  /** 解析音乐结果 → 更新 Now Playing + 播放 */
  _handleMusicResult(result, onPlay) {
    if (!result || !result.songs || !result.songs.length) return;

    const song = result.songs[0];
    const title = song.name || song.title || '未知曲目';
    const artist = song.artist || song.ar?.map(a => a.name).join(' / ') || '未知艺人';
    const cover = song.cover || song.al?.picUrl || '';
    const url = song.url || '';
    const album = song.album || song.al?.name || '';

    // 播放音频
    if (url && this._audioEl) {
      this._audioEl.src = url;
      this._audioEl.play().catch(() => {});
    }

    // 传递完整歌曲列表（用于推荐队列）和当前曲目
    onPlay?.({
      title, artist, cover, url, album,
      id: song.id || '',
      allSongs: result.songs,
    });
  }
}

// ── 打字机引擎 ──
// 外部文本通过 enqueue() 逐 chunk 送入，内部按字符排入 FIFO，
// 定时器以固定间隔（默认 28ms）逐个消费并回调 onChar。
class Typewriter {
  constructor(speed = 28) {
    this._queue = [];
    this._timer = null;
    this._speed = speed;
    this._onChar = null;
    this._onFlush = null;   // flush 完成时的回调
  }

  /** 启动打字机，注册每跳出一个字符的回调 */
  start(onChar) {
    this._onChar = onChar;
    this._tick();
  }

  /** 将一段文本拆成字符排入队列 */
  enqueue(text) {
    for (let i = 0; i < text.length; i++) {
      this._queue.push(text[i]);
    }
    this._tick();
  }

  /** 定时消费队列 */
  _tick() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      // 每帧跳出 2 个字符，平衡速度与流畅感
      for (let i = 0; i < 2 && this._queue.length > 0; i++) {
        const ch = this._queue.shift();
        this._onChar?.(ch);
      }
      // 队列空了就暂停，有新数据进来再恢复
      if (this._queue.length === 0) {
        clearInterval(this._timer);
        this._timer = null;
      }
    }, this._speed);
  }

  /** 清空队列（中止 / 出错时调用） */
  clear() {
    this._queue.length = 0;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._onFlush = null;
  }

  /** 等队列排空后执行回调 */
  flush(callback) {
    if (this._queue.length === 0 && !this._timer) {
      callback?.();
      return;
    }
    // 检查是否已在 tick 中
    const check = setInterval(() => {
      if (this._queue.length === 0 && !this._timer) {
        clearInterval(check);
        callback?.();
      }
    }, 30);
  }
}

// 导出单例
window.claudioStream = new ClaudioStream();
