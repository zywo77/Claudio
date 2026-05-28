// ═══════════════════════════════════════════════════
//  Scheduler — 节律调度系统
//
//  读取 user/routines.md → 监听时间 → 触发 DJ 管线
//  管线: Prompt 组装 → Agent 对话 → TTS 合成 → 前端播放
// ═══════════════════════════════════════════════════

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildContext } from "./context.js";
import { state } from "./state.js";

const ROOT = resolve(import.meta.dirname, "..");

// ── 作息解析 ───────────────────────────────────────

/**
 * 解析 routines.md 中的表格行，提取时间槽位。
 * 格式: | 起床 | 07:00-07:30 | 轻快有活力，帮助醒脑 |
 */
async function parseRoutines() {
  const raw = await readFile(resolve(ROOT, "user", "routines.md"), "utf-8");
  const slots = [];

  for (const line of raw.split("\n")) {
    const m = line.match(/^\|\s*(.+?)\s*\|\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*\|\s*(.+?)\s*\|/);
    if (!m) continue;

    const [, name, start, end, need] = m;
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);

    slots.push({
      name: name.trim(),
      startMin: sh * 60 + sm,
      endMin: eh * 60 + em,
      startStr: start,
      endStr: end,
      need: need.trim(),
    });
  }

  return slots;
}

// ── 主类 ───────────────────────────────────────────

export class Scheduler {
  /**
   * @param {Object} opts
   * @param {import("./agent.js").Agent} opts.agent
   * @param {import("./tts.js").TTS} opts.tts
   * @param {import("./music.js").MusicClient} opts.music
   * @param {import("./weather.js").WeatherClient} [opts.weather]
   */
  constructor({ agent, tts, music, weather }) {
    this.agent = agent;
    this.tts = tts;
    this.music = music;
    this.weather = weather;

    /** @type {Array<{name:string, startMin:number, endMin:number, startStr:string, endStr:string, need:string}>} */
    this.slots = [];

    /** 当前活跃的槽位名（避免重复触发） */
    this._activeSlot = null;

    /** setInterval id */
    this._timer = null;

    /** 最近一次触发的段信息（供前端轮询） */
    this.latestSegment = null;

    /** 节律触发次数统计 */
    this.fireCount = 0;
  }

  // ── 初始化 ──────────────────────────────────────

  async init() {
    this.slots = await parseRoutines();
    console.log(`[Scheduler] 解析到 ${this.slots.length} 个作息槽位:`);
    for (const s of this.slots) {
      console.log(`   ${s.startStr}-${s.endStr}  ${s.name}  → ${s.need.slice(0, 40)}`);
    }
  }

  // ── 主循环 ──────────────────────────────────────

  /** 启动调度循环（每 30 秒检查一次） */
  start() {
    if (this._timer) return;

    this._timer = setInterval(() => this._tick(), 30_000);
    // 启动时立即检查一次
    this._tick();

    console.log("[Scheduler] 节律调度系统已上线，正在监听作息节点...");
  }

  /** 停止调度 */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** 每次 tick 检查是否进入新槽位 */
  async _tick() {
    try {
      const now = new Date();
      const day = now.getDay(); // 0=周日, 6=周六
      const isWeekend = day === 0 || day === 6;
      const nowMin = now.getHours() * 60 + now.getMinutes();

      // 找当前时间所在的槽位
      const current = this.slots.find(
        (s) => nowMin >= s.startMin && nowMin < s.endMin
      );

      const slotKey = current ? `${current.startStr}-${current.name}` : null;

      // 周末跳过工作相关槽位
      if (current && isWeekend && /工作|通勤/.test(current.name)) {
        return;
      }

      // 槽位未变化 / 仍在同一槽位内 → 不重复触发
      if (slotKey === this._activeSlot) return;

      if (current) {
        this._activeSlot = slotKey;
        console.log(`\n[Scheduler] ⏰ ${now.toTimeString().slice(0, 5)} → 进入「${current.name}」时段`);
        await this._fire(current);
      } else {
        this._activeSlot = null;
      }
    } catch (err) {
      console.error("[Scheduler] tick 异常:", err.message);
    }
  }

  // ── 触发管线 ────────────────────────────────────

  /**
   * ★ 核心管线：Prompt → Agent → TTS → 状态存储
   * @param {{name:string, startMin:number, endMin:number, startStr:string, endStr:string, need:string}} slot
   */
  async _fire(slot) {
    const startTime = Date.now();
    const timeStr = slot.startStr || `${String(Math.floor(slot.startMin / 60)).padStart(2, "0")}:${String(slot.startMin % 60).padStart(2, "0")}`;

    try {
      // Step 1 — 获取天气摘要
      let weatherLine = "天气暂不可用";
      if (this.weather) {
        try { weatherLine = await this.weather.summary(); } catch {}
      }

      // Step 2 — 构建用户触发消息（简洁指令，上下文由 6 盒子 system prompt 提供）
      const userMessage = [
        `[系统调度触发]`,
        `现在是 ${timeStr}，根据用户作息，现在是「${slot.name}」时间。`,
        ``,
        `任务：`,
        `1. 用 Claudio 的 DJ 语气说一小段开场白（3-5句，温暖自然），提及现在是${slot.name}时间`,
        `2. 根据用户品味和当前时段需求（${slot.need}），先翻收藏 (music_my_playlists)，再搜索 (music_search)`,
        `3. 调用 music_song_url 获取播放链接`,
        `4. 按照输出格式返回：[开场白] + 🎵 **歌名** — 歌手 + [🎧 点击播放](链接)`,
      ].join("\n");

      // Step 3 — 用 6 盒子组装 system prompt，注入节律上下文
      const systemPrompt = await buildContext(
        { rawText: userMessage, kind: "llm" },
        {
          source: "cron",
          weatherLine,
          planSegment: `${slot.name} (${slot.need})`,
        }
      );

      // Step 4 — 调用 Agent（加锁防止与用户请求冲突）
      const release = await this.agent.acquire();
      let result;
      try {
        this.agent.messages[0] = { role: "system", content: systemPrompt };
        console.log(`[Scheduler] 🤖 向 DeepSeek 发送调度 Prompt (w/ 6-box context)...`);
        result = await this.agent.chat(userMessage);
        const reply = result.content ?? "";
      } finally {
        // 清理调度器留下的消息历史，只保留系统 prompt
        this.agent.messages = [this.agent.messages[0]];
        release();
      }
      const reply = result.content ?? "";

      console.log(`[Scheduler] 💬 AI 回复 (${result.rounds}轮, ${result.toolCalls}次工具):`);
      console.log(`   ${reply.slice(0, 200).replace(/\n/g, "\n   ")}...`);

      // Step 3 — 从回复中提取音乐直链
      let musicUrl = null;
      const urlMatch = reply.match(/https?:\/\/[^\s"'<>]+?\.(?:126\.(?:net|com))\S+/);
      if (urlMatch) {
        musicUrl = `/api/stream?url=${encodeURIComponent(urlMatch[0])}`;
      }

      // Step 4 — TTS 合成（非阻塞）
      let audioPath = null;
      let audioUrl = null;
      try {
        const ttsResult = await this.tts.synth(reply);
        if (ttsResult.path) {
          audioPath = ttsResult.path;
          audioUrl = ttsResult.path
            .replace(/\\/g, "/")
            .replace(/^.*?cache\/tts\//, "/cache/tts/");
        }
        console.log(`[Scheduler] 🔊 TTS 合成: ${ttsResult.provider} → ${audioPath ?? "降级到浏览器"}`);
      } catch (ttsErr) {
        console.warn(`[Scheduler] TTS 合成失败: ${ttsErr.message}`);
      }

      // Step 5 — 存储到 latestSegment（前端轮询用）
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.latestSegment = {
        slot: slot.name,
        time: timeStr,
        need: slot.need,
        reply,
        audioUrl,        // TTS mp3 路径 → 前端播放
        musicUrl,        // 音乐代理链接
        rounds: result.rounds,
        toolCalls: result.toolCalls,
        elapsed: `${elapsed}s`,
        ts: Date.now(),
      };

      this.fireCount++;

      // Step 6 — 写入 State 记忆（播放记录持久化）
      const songMatch = reply.match(/🎵\s*\*?\*?([^*\n]+)\*?\*?\s*[—\-]\s*([^\n]+)/);
      const songInfo = songMatch
        ? { name: songMatch[1].trim(), artist: songMatch[2].trim() }
        : null;

      await state.recordSchedulerPlay({
        slot: slot.name,
        djText: reply,
        weather: weatherLine,
        song: songInfo,
        url: musicUrl,
        rounds: result.rounds,
        toolCalls: result.toolCalls,
      });

      console.log(`[State] 记忆已写入。当前电台已累积 ${state.playCount} 次播放记录。`);
      console.log(`[Scheduler] ✅ 触发完成 (耗时 ${elapsed}s) → ${slot.name}\n`);
    } catch (err) {
      console.error(`[Scheduler] ❌ 触发失败 (${slot.name}):`, err.message);
    }
  }

  // ── 测试模式 ────────────────────────────────────

  /**
   * 测试触发：在指定分钟数后执行一次 DJ 管线。
   * @param {string} [slotName="午后提神"] - 测试用的时段名
   * @param {number} [delayMinutes=2] - 延迟分钟数
   */
  testFire(slotName = "午后提神", delayMinutes = 2) {
    const slot = {
      name: slotName,
      startMin: 0,
      endMin: 0,
      startStr: new Date(Date.now() + delayMinutes * 60_000).toTimeString().slice(0, 5),
      endStr: "",
      need: "下午茶时间，提神醒脑，来点轻快有活力的音乐",
    };

    const fireAt = new Date(Date.now() + delayMinutes * 60_000);
    console.log(`\n[Scheduler] 🧪 测试模式已激活`);
    console.log(`   将在 ${fireAt.toTimeString().slice(0, 5)}（${delayMinutes} 分钟后）触发「${slotName}」`);
    console.log(`   等待中...`);

    const delay = delayMinutes * 60_000;
    setTimeout(async () => {
      console.log(`\n[Scheduler] 🧪 测试触发!`);
      await this._fire(slot);
    }, delay);

    return fireAt;
  }

  // ── 状态查询 ────────────────────────────────────

  getStatus() {
    return {
      active: !!this._timer,
      slotCount: this.slots.length,
      activeSlot: this._activeSlot,
      fireCount: this.fireCount,
      latestSegment: this.latestSegment,
    };
  }
}
