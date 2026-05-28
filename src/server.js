const express = require('express');
require('dotenv').config();

const state = require('./state');
const context = require('./context');
const claude = require('./claude');
const music = require('./music');
const tts = require('./tts');
const weather = require('./integrations/weather');

// ── 初始化 ──
state.init();

// ── 注册工具执行器（MiMo Tool Use → 本地函数） ──

claude.registerTool('search_music', async (args) => {
  try {
    const songs = await music.search(args.keyword, { limit: args.limit || 4 });
    const top = songs.slice(0, 4);
    const withUrl = await Promise.all(top.map(async (s) => {
      try {
        const u = await music.songUrl(s.id);
        return { id: s.id, name: s.name, artist: s.artist, album: s.album, url: u.url, cover: s.cover, duration: s.duration };
      } catch { return { id: s.id, name: s.name, artist: s.artist, album: s.album, url: '', cover: s.cover, duration: s.duration }; }
    }));
    return { success: true, songs: withUrl };
  } catch (e) {
    return { success: false, error: e.message, hint: '网易云音乐 API 尚未配置' };
  }
});

// 记住上次推荐的风格关键词（用于"换一批"/"换一类"）
let _lastStyleKeyword = '';

// 判断是否为中文字符
function hasChinese(str) {
  return /[一-鿿]/.test(str);
}

// 根据关键词语言过滤歌曲
function filterByLanguage(songs, keyword) {
  // 如果关键词是中文，不做过滤（保留所有歌曲）
  if (hasChinese(keyword)) return songs;
  // 非中文关键词（如 R&B, Jazz）：过滤掉纯中文歌名+中文歌手的歌曲
  return songs.filter(s => {
    const nameChinese = hasChinese(s.name);
    const artistChinese = hasChinese(s.artist);
    // 保留：英文歌名、或有英文歌手名的、或中英文混合的
    return !(nameChinese && artistChinese);
  });
}

// Fisher-Yates 洗牌
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 去重（按歌曲 id）
function dedupe(songs) {
  const seen = new Set();
  return songs.filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

// 获取用户收藏的 top 艺人（从数据库缓存或实时拉取）
async function getUserTopArtists(limit = 8) {
  try {
    const loginInfo = await music.loginStatus();
    if (!loginInfo.logged) return [];
    const playlists = await music.playlistAll(loginInfo.uid);
    const likesPlaylist = playlists.find(p =>
      p.name === '喜欢的音乐' || p.name === 'LIKES' || p.name.includes('喜欢')
    );
    if (!likesPlaylist) return [];
    const tracks = await music.playlistTracks(likesPlaylist.id);
    const artistCount = {};
    tracks.forEach(s => {
      s.artist.split(' / ').forEach(a => {
        if (a.trim()) artistCount[a.trim()] = (artistCount[a.trim()] || 0) + 1;
      });
    });
    return Object.entries(artistCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name]) => name);
  } catch { return []; }
}

// 学习：保存用户喜欢的风格关键词
function learnStyle(keyword) {
  if (!keyword) return;
  try {
    const existing = state.getPref('learned_styles');
    let styles = [];
    try { styles = JSON.parse(existing || '[]'); } catch {}
    styles = styles.filter(s => s !== keyword);
    styles.unshift(keyword);
    styles = styles.slice(0, 20);
    state.setPref('learned_styles', JSON.stringify(styles));
  } catch {}
}

// 学习：获取已学习的风格关键词
function getLearnedStyles() {
  try {
    const existing = state.getPref('learned_styles');
    return JSON.parse(existing || '[]');
  } catch { return []; }
}

claude.registerTool('recommend_music', async (args) => {
  try {
    let allSongs = [];
    const mood = (args.mood || '').trim();
    if (mood) {
      _lastStyleKeyword = mood;
      learnStyle(mood);
    }

    // 0. 获取最近播放过的歌曲 ID（排除用）
    const recentIds = new Set();
    try {
      const recentPlays = state.recentPlays(50);
      recentPlays.forEach(p => recentIds.add(p.song_id));
    } catch {}

    // 1. 获取用户收藏的 top 艺人（推荐根基）
    const topArtists = await getUserTopArtists(12);

    // 2. 搜索策略：品味 + 心境组合，多艺人轮换
    if (mood && topArtists.length > 0) {
      // 随机选 2 个 top 艺人组合搜索
      const shuffled = shuffle([...topArtists]);
      const picked = shuffled.slice(0, 2);
      for (const artist of picked) {
        try {
          const searched = await music.search(`${artist} ${mood}`, { limit: 8 });
          allSongs.push(...searched);
        } catch {}
      }
      // 也单独搜心境关键词（拓宽来源）
      try {
        allSongs.push(...await music.search(mood, { limit: 10 }));
      } catch {}
      // 用学习过的风格补充
      const learned = getLearnedStyles().filter(s => s !== mood);
      if (learned.length > 0) {
        const extraStyle = learned[Math.floor(Math.random() * learned.length)];
        try { allSongs.push(...await music.search(extraStyle, { limit: 6 })); } catch {}
      }
    } else if (mood) {
      try { allSongs.push(...await music.search(mood, { limit: 12 })); } catch {}
    } else if (topArtists.length > 0) {
      // 没有心境，随机选 2 个 top 艺人搜索
      const shuffled = shuffle([...topArtists]);
      const picked = shuffled.slice(0, 2);
      for (const artist of picked) {
        try { allSongs.push(...await music.search(artist, { limit: 8 })); } catch {}
      }
    }

    // 3. 补充：每日推荐 + 私人FM
    try { allSongs.push(...await music.recommend()); } catch {}
    try { allSongs.push(...await music.personalFm()); } catch {}

    // 4. 去重 + 排除最近播放 + 洗牌
    allSongs = dedupe(allSongs);
    if (recentIds.size > 0) {
      allSongs = allSongs.filter(s => !recentIds.has(s.id));
    }
    if (allSongs.length === 0) {
      return { success: false, error: '暂无推荐' };
    }
    shuffle(allSongs);

    // 5. 品味优先：收藏中出现过的艺人排前面
    if (topArtists.length > 0) {
      const artistSet = new Set(topArtists);
      const matched = allSongs.filter(s => artistSet.has(s.artist));
      const others = allSongs.filter(s => !artistSet.has(s.artist));
      const take = Math.min(matched.length, 3);
      allSongs = [...shuffle([...matched]).slice(0, take), ...shuffle([...others]).slice(0, 4 - take)];
      shuffle(allSongs);
    }

    // 6. 非中文关键词过滤纯中文歌曲
    if (mood && !hasChinese(mood)) {
      const filtered = filterByLanguage(allSongs, mood);
      if (filtered.length >= 2) allSongs = filtered;
    }

    // 7. 取前4首，获取播放链接
    const top = allSongs.slice(0, 4);
    const withUrl = await Promise.all(top.map(async (s) => {
      try {
        const u = await music.songUrl(s.id);
        return { id: s.id, name: s.name, artist: s.artist, album: s.album, url: u.url, cover: s.cover, duration: s.duration };
      } catch { return { id: s.id, name: s.name, artist: s.artist, album: s.album, url: '', cover: s.cover, duration: s.duration }; }
    }));
    return { success: true, songs: withUrl, taste: topArtists.slice(0, 5) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

claude.registerTool('get_weather', async (args) => {
  try {
    return await weather.fetchWeather(args.city || '北京');
  } catch (e) {
    return { city: args.city || '北京', condition: '未知', temp: '未知', error: e.message };
  }
});

claude.registerTool('get_calendar', async (args) => {
  return { upcoming: [], message: '日历暂未接入' };
});

claude.registerTool('personal_fm', async () => {
  try {
    const songs = await music.personalFm();
    const top = songs.slice(0, 4);
    const withUrl = await Promise.all(top.map(async (s) => {
      try {
        const u = await music.songUrl(s.id);
        return { id: s.id, name: s.name, artist: s.artist, url: u.url, cover: s.cover, duration: s.duration };
      } catch { return { id: s.id, name: s.name, artist: s.artist, url: '' }; }
    }));
    return { success: true, songs: withUrl };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

claude.registerTool('recent_songs', async () => {
  try {
    const songs = await music.recentSong();
    return {
      success: true,
      songs: songs.slice(0, 10).map(s => ({ id: s.id, name: s.name, artist: s.artist, cover: s.cover })),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

claude.registerTool('search_favorites', async (args) => {
  try {
    const loginInfo = await music.loginStatus();
    if (!loginInfo.logged) {
      return { success: false, error: '未登录网易云音乐，请先登录' };
    }
    const playlists = await music.playlistAll(loginInfo.uid);
    const likesPlaylist = playlists.find(p =>
      p.name === '喜欢的音乐' || p.name === 'LIKES' || p.name.includes('喜欢')
    );
    if (!likesPlaylist) {
      return { success: false, error: '未找到收藏歌单' };
    }
    const tracks = await music.playlistTracks(likesPlaylist.id);
    const keyword = (args.keyword || '').toLowerCase();
    const matched = tracks.filter(s =>
      s.name.toLowerCase().includes(keyword) ||
      s.artist.toLowerCase().includes(keyword) ||
      s.album.toLowerCase().includes(keyword)
    );
    if (matched.length === 0) {
      return { success: true, songs: [], message: `收藏夹中没有找到"${args.keyword}"相关的歌曲` };
    }
    const top = matched.slice(0, 4);
    const withUrl = await Promise.all(top.map(async (s) => {
      try {
        const u = await music.songUrl(s.id);
        return { ...s, url: u.url };
      } catch { return { ...s, url: '' }; }
    }));
    return { success: true, songs: withUrl, total: matched.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

claude.registerTool('get_user_taste', async () => {
  try {
    const loginInfo = await music.loginStatus();
    if (!loginInfo.logged) {
      return { success: false, error: '未登录' };
    }
    const playlists = await music.playlistAll(loginInfo.uid);
    const likesPlaylist = playlists.find(p =>
      p.name === '喜欢的音乐' || p.name === 'LIKES' || p.name.includes('喜欢')
    );
    if (!likesPlaylist) {
      return { success: false, error: '未找到收藏歌单' };
    }
    const tracks = await music.playlistTracks(likesPlaylist.id);
    // 统计艺人出现频率
    const artistCount = {};
    tracks.forEach(s => {
      const artists = s.artist.split(' / ');
      artists.forEach(a => { artistCount[a] = (artistCount[a] || 0) + 1; });
    });
    const topArtists = Object.entries(artistCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([name, count]) => `${name}(${count}首)`);
    return {
      success: true,
      total: tracks.length,
      topArtists,
      sampleSongs: tracks.slice(0, 10).map(s => `${s.name} - ${s.artist}`),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

claude.registerTool('save_user_note', async (args) => {
  try {
    state.saveUserNote(args.note);
    return { success: true, message: '已记住' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

claude.registerTool('set_language', async (args) => {
  try {
    state.setPref('language', args.lang);
    return { success: true, lang: args.lang };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Express ──
const app = express();
app.use(express.json());
app.use(require('cors')());
app.use(express.static(require('path').join(__dirname, '..', 'pwa')));
app.use('/fonts', express.static(require('path').join(__dirname, '..', 'node_modules', '@fontsource')));

// ── 情绪标签解析 ──
const MOOD_RE = /\[mood:(sad|anxious|calm|happy|melancholy|energetic)\]\s*/;

function extractMood(text) {
  const match = text.match(MOOD_RE);
  if (match) {
    return { mood: match[1], cleanText: text.replace(MOOD_RE, '') };
  }
  return { mood: null, cleanText: text };
}

// ── 文本清理：移除技术内容 ──
function cleanTextForUser(text) {
  if (!text) return text;

  return text
    // 移除情绪标签（最常见，优先处理）
    .replace(/\[mood:(sad|anxious|calm|happy|melancholy|energetic)\]\s*/g, '')
    // 移除工具调用格式
    .replace(/\[(get_weather|search_music|recommend_music|get_calendar|search_favorites)\]/g, '')
    // 移除 DeepSeek 泄露的工具调用 XML
    .replace(/<｜｜DSML｜｜tool_calls>[\s\S]*?<｜｜DSML｜｜tool_calls>/g, '')
    // 移除代码块 ```
    .replace(/```[\s\S]*?```/g, '')
    // 移除行内代码 `...`
    .replace(/`[^`]+`/g, '')
    // 移除 Markdown 加粗标记
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // 移除工具操作播报（"我搜一下"、"搜到了"等）
    .replace(/我(去)?搜(一下|搜看|看看).*?[，。,.]/g, '')
    .replace(/搜(到|好了|完了)[了]?.*?[，。,.]/g, '')
    .replace(/找到了.*?[，。,.]/g, '')
    .replace(/让我?(找找|看看|搜搜).*?[，。,.]/g, '')
    .replace(/找(到|好了|完了)[了]?.*?[，。,.]/g, '')
    .replace(/稍等.*?[，。,.]/g, '')
    .replace(/来了.*?[，。,.]/g, '')
    // 移除内心独白/自我分析（"你问了X次"、"说明我还没找到"等）
    .replace(/你(问|说|要|提)(了)?[一二三四五六七八九十\d]+次[了]?[，。,.]?\s*/g, '')
    .replace(/我(也)?(推|推荐|找|选)(了)?[一二三四五六七八九十\d]+次[了]?[，。,.]?\s*/g, '')
    .replace(/从.{1,10}到.{1,10}(你)?都(听|试|推|看)(过|了)[了]?[，。,.]?\s*/g, '')
    .replace(/说明(我|你).{0,20}(没|不)(找到|找到过)[了]?.*?[，。,.]/g, '')
    .replace(/这次(换|试)(一个?|个?).{0,10}(方向|风格|路线|思路)[，。,.]?\s*/g, '')
    .replace(/那(就|我)(换|换一个?|试试).{0,15}[，。,.]?\s*/g, '')
    // 移除时间播报（中文数字+阿拉伯数字全覆盖）
    .replace(/[一二三四五六七八九十\d]{1,2}[点时][一二三四五六七八九十\d]{0,2}分?[，。,.]?\s*/g, '')
    .replace(/现在是[周星期][一二三四五六日天](凌晨|早上|上午|中午|下午|傍晚|晚上|深夜)[，。,.]?\s*/g, '')
    .replace(/(凌晨|早上|上午|中午|下午|傍晚|晚上|深夜)\s*[一二三四五六七八九十\d]{1,2}[点时][一二三四五六七八九十\d]{0,2}分?[，。,.]?\s*/g, '')
    .replace(/(周|星期)[一二三四五六日天](凌晨|早上|上午|中午|下午|傍晚|晚上|深夜)[，。,.]?\s*/g, '')
    // 移除独立时间短语（"这个时刻"、"这个时间"等）
    .replace(/(这个|此时|此刻)(时刻|时间|时分)[，。,.]?\s*/g, '')
    // 移除时间相关的完整句子（兜底）
    .replace(/[^。！？\n]*(七点|八点|九点|十点|六点|五点|四点|三点|两点|一点|零点|中午|傍晚|深夜|凌晨|天亮|天黑|日落|日出)[^。！？\n]*[。！？]/g, '')
    // 移除多余空行
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '')
    .trim();
}

// ── 核心路由：POST /api/chat（SSE 流式） ──
app.post('/api/chat', async (req, res) => {
  try {
    const { message, source = 'chat' } = req.body;
    const userId = 'default';

    // 写入用户消息
    state.appendMessage(userId, 'user', message, source);

    // 组装 6-box prompt（实时注入天气）
    let weatherStr = '';
    try {
      const w = await weather.fetchWeather('上海');
      weatherStr = `${w.condition} ${w.temp} 体感${w.feelsLike}`;
    } catch {}

    const { messages } = context.build(
      { text: message, source },
      userId,
      { state, weather: weatherStr }
    );

    // 歌词辨认检测
    const isLyricGuess = /(?:这是哪首歌|哪首歌|什么歌|出自哪里|哪首歌里|是哪个歌手|歌词.*是什么歌|什么歌.*歌词)/.test(message);

    // SSE 流式响应
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let fullReply = '';
    let textBuffer = '';
    let detectedMood = null;
    let musicToolCalled = false;
    let recommendToolCalled = false;

    for await (const chunk of claude.chatStream(messages)) {
      switch (chunk.type) {
        case 'text':
          fullReply += chunk.content;
          textBuffer += chunk.content;

          // 先清理整个缓冲区，再按换行分割发送
          textBuffer = cleanTextForUser(textBuffer);

          const lastNewline = textBuffer.lastIndexOf('\n');
          if (lastNewline !== -1) {
            const toSend = textBuffer.slice(0, lastNewline + 1);
            textBuffer = textBuffer.slice(lastNewline + 1);
            if (toSend.trim()) {
              res.write(`data: ${JSON.stringify({ type: 'text', content: toSend })}\n\n`);
            }
          }
          break;

        case 'tool_calls':
          res.write(`data: ${JSON.stringify({ type: 'tool_calls', calls: chunk.tool_calls.map(tc => tc.name), ...(isLyricGuess && { context: 'lyric_guess' }) })}\n\n`);
          break;

        case 'tool_result':
          if (chunk.name === 'search_music' || chunk.name === 'recommend_music' || chunk.name === 'search_favorites') {
            musicToolCalled = true;
          }
          if (chunk.name === 'recommend_music') {
            recommendToolCalled = true;
          }
          // 记录播放历史
          if (chunk.result && chunk.result.songs) {
            chunk.result.songs.forEach(s => {
              try { state.appendPlay('default', s.id, s.name, s.artist); } catch {}
            });
          }
          res.write(`data: ${JSON.stringify({ type: 'tool_result', name: chunk.name, result: chunk.result, ...(isLyricGuess && { context: 'lyric_guess' }) })}\n\n`);
          break;
      }
    }

    // 兜底：如果用户请求音乐但 AI 没调用工具，或推荐请求却调了搜索
    const searchRe = /^(?!.*收藏)(?:播放|放一首|我想听|想听|来首|搜索|找|播|放)(.{1,20}?)(?:的歌|的音乐|歌曲|歌|音乐)?$/;
    const recommendRe = /(?:推荐|放点|来点|听点|想听|随便放|来点什么|听什么|今天听|有什么好听)/;
    const songMentionRe = /《([^》]{1,30})》/g;

    const isRecommendRequest = recommendRe.test(message);
    const isSearchRequest = searchRe.test(message);

    if (!musicToolCalled) {
      // AI 完全没调用任何音乐工具，走兜底
      let fallbackHandled = false;

      // 先检查搜索请求（带关键词的优先，如"想听rap"）
      if (isSearchRequest) {
        const m = message.match(searchRe);
        if (m && m[1]) {
          const keyword = m[1].trim();
          if (keyword.length >= 1) {
            try {
              const songs = await music.search(keyword, { limit: 4 });
              const top = songs.slice(0, 4);
              const withUrl = await Promise.all(top.map(async (s) => {
                try {
                  const u = await music.songUrl(s.id);
                  return { id: s.id, name: s.name, artist: s.artist, album: s.album, url: u.url, cover: s.cover, duration: s.duration };
                } catch { return { id: s.id, name: s.name, artist: s.artist, album: s.album, url: '', cover: s.cover, duration: s.duration }; }
              }));
              const result = { success: true, songs: withUrl };
              withUrl.forEach(s => { try { state.appendPlay('default', s.id, s.name, s.artist); } catch {} });
              res.write(`data: ${JSON.stringify({ type: 'tool_calls', calls: ['search_music'] })}\n\n`);
              res.write(`data: ${JSON.stringify({ type: 'tool_result', name: 'search_music', result })}\n\n`);
              fallbackHandled = true;
            } catch (e) {
              console.error('[fallback] search_music error:', e.message);
            }
          }
        }
      }

      // 推荐请求兜底（无关键词的泛推荐）
      if (!fallbackHandled && isRecommendRequest) {
        try {
          let allSongs = [];
          const learned = getLearnedStyles();
          if (learned.length > 0) {
            const kw = learned[Math.floor(Math.random() * learned.length)];
            try { allSongs.push(...await music.search(kw, { limit: 10 })); } catch {}
          }
          try { allSongs.push(...await music.recommend()); } catch {}
          try { allSongs.push(...await music.personalFm()); } catch {}
          shuffle(allSongs);
          const top = allSongs.slice(0, 4);
          const withUrl = await Promise.all(top.map(async (s) => {
            try {
              const u = await music.songUrl(s.id);
              return { id: s.id, name: s.name, artist: s.artist, album: s.album, url: u.url, cover: s.cover, duration: s.duration };
            } catch { return { id: s.id, name: s.name, artist: s.artist, album: s.album, url: '', cover: s.cover, duration: s.duration }; }
          }));
          const result = { success: true, songs: withUrl };
          withUrl.forEach(s => { try { state.appendPlay('default', s.id, s.name, s.artist); } catch {} });
          res.write(`data: ${JSON.stringify({ type: 'tool_calls', calls: ['recommend_music'] })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'tool_result', name: 'recommend_music', result })}\n\n`);
          fallbackHandled = true;
        } catch (e) {
          console.error('[fallback] recommend_music error:', e.message);
        }
      }

    }

    // AI 提到具体歌名时，搜索每一首提到的歌（仅在 AI 没调用音乐工具时才执行，歌词辨认除外）
    if (fullReply && !musicToolCalled && !isLyricGuess) {
      const mentioned = [];
      let match;
      while ((match = songMentionRe.exec(fullReply)) !== null) {
        mentioned.push(match[1]);
      }
      if (mentioned.length > 0) {
        const found = [];
        for (const name of mentioned) {
          try {
            const songs = await music.search(name, { limit: 3 });
            if (songs.length > 0) found.push(songs[0]);
          } catch {}
          if (found.length >= 4) break;
        }
        if (found.length > 0) {
          const withUrl = await Promise.all(found.map(async (s) => {
            try {
              const u = await music.songUrl(s.id);
              return { id: s.id, name: s.name, artist: s.artist, album: s.album, url: u.url, cover: s.cover, duration: s.duration };
            } catch { return { id: s.id, name: s.name, artist: s.artist, album: s.album, url: '', cover: s.cover, duration: s.duration }; }
          }));
          const result = { success: true, songs: withUrl };
          withUrl.forEach(s => { try { state.appendPlay('default', s.id, s.name, s.artist); } catch {} });
          res.write(`data: ${JSON.stringify({ type: 'tool_calls', calls: ['search_music'] })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'tool_result', name: 'search_music', result })}\n\n`);
        }
      }
    }

    // 发送缓冲区剩余内容
    if (textBuffer.trim()) {
      const cleaned = cleanTextForUser(textBuffer);
      if (cleaned) {
        res.write(`data: ${JSON.stringify({ type: 'text', content: cleaned })}\n\n`);
      }
    }

    // 写入助手回复（清理后存储）
    if (fullReply) {
      const { mood, cleanText } = extractMood(fullReply);
      const finalText = cleanTextForUser(cleanText);
      state.appendMessage(userId, 'assistant', finalText, source);

      if (mood) {
        detectedMood = mood;
        res.write(`data: ${JSON.stringify({ type: 'mood', mood })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

// ── 查询接口 ──
app.get('/api/now', (req, res) => {
  res.json({ playing: null, hint: '暂无播放，播放状态将在 PWA 接入后实时更新' });
});

app.get('/api/next', (req, res) => {
  res.json({ next: null, queue: [] });
});

app.get('/api/taste', async (req, res) => {
  const taste = context.boxUserCorpus();
  res.json({ taste: taste || '用户品味数据尚未填写' });
});

app.get('/api/lyric', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.json({ lyric: '', tlyric: '' });
    const result = await music.lyric(id);
    res.json(result);
  } catch (e) {
    res.json({ lyric: '', tlyric: '', error: e.message });
  }
});

app.get('/api/login-status', async (req, res) => {
  try {
    const status = await music.loginStatus();
    res.json(status);
  } catch (e) {
    res.json({ logged: false, error: e.message });
  }
});

app.get('/api/fm', async (req, res) => {
  try {
    const songs = await music.personalFm();
    res.json({ songs });
  } catch (e) {
    res.json({ songs: [], error: e.message });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const songs = await music.recentSong();
    res.json({ songs: songs.slice(0, 30) });
  } catch (e) {
    res.json({ songs: [], error: e.message });
  }
});

app.get('/api/recommend', async (req, res) => {
  try {
    const songs = await music.recommend();
    res.json({ songs });
  } catch (e) {
    res.json({ songs: [], error: e.message });
  }
});

app.get('/api/plan/today', (req, res) => {
  const plan = state.getPlan(new Date().toISOString().slice(0, 10));
  res.json({ plan: plan || {} });
});

// ── TTS 合成 + 逐字时间戳 ──
app.post('/api/tts', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'missing text' });
    const result = await tts.generate(text);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 刷新歌曲 URL（收藏/最近播放点击时调用） ──
app.post('/api/refresh-url', async (req, res) => {
  try {
    const { title, artist, id } = req.body;
    if (!title && !id) return res.status(400).json({ error: 'missing title or id' });

    // 如果有歌曲 ID，直接用 ID 获取 URL
    if (id) {
      try {
        const u = await music.songUrl(id);
        if (u.url) return res.json({ success: true, url: u.url, id });
      } catch {}
    }

    if (!title) return res.json({ success: false, error: '未找到' });

    // 搜索策略：先用 title+artist，再用 title alone
    let songs = [];
    const keyword = artist ? `${title} ${artist}` : title;
    try { songs = await music.search(keyword, { limit: 8 }); } catch {}
    if (songs.length === 0 && artist) {
      try { songs = await music.search(title, { limit: 8 }); } catch {}
    }

    // 匹配策略：精确同名+同歌手 → 精确同名 → 模糊匹配 → 第一首
    let matched = null;
    if (artist) {
      matched = songs.find(s =>
        s.name === title && (s.artist.includes(artist) || artist.includes(s.artist))
      );
    }
    if (!matched) matched = songs.find(s => s.name === title);
    if (!matched) matched = songs.find(s =>
      s.name.includes(title) || title.includes(s.name)
    );
    if (!matched) matched = songs[0];
    if (!matched) return res.json({ success: false, error: '未找到' });

    // 获取 URL，如果第一首没有链接，尝试其他匹配的歌曲
    const candidates = songs.filter(s => s.id === matched.id || s.name === matched.name);
    for (const s of candidates) {
      try {
        const u = await music.songUrl(s.id);
        if (u.url) return res.json({ success: true, url: u.url, id: s.id });
      } catch {}
    }

    // 所有候选都没有链接
    res.json({ success: false, error: '该歌曲暂无可用播放链接' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── 设置 Cookie 并自动导入"喜欢的音乐"歌单 ──
app.post('/api/set-cookie', async (req, res) => {
  try {
    const { cookie } = req.body;
    if (!cookie || !cookie.trim()) {
      return res.json({ success: false, error: '请粘贴 Cookie' });
    }

    // 设置 cookie 环境变量（music.js 的 opts() 每次都读 process.env.NCM_COOKIE）
    process.env.NCM_COOKIE = cookie.trim();

    // 验证登录状态
    const loginInfo = await music.loginStatus();
    if (!loginInfo.logged) {
      return res.json({ success: false, error: 'Cookie 无效或已过期，请重新获取' });
    }

    // 获取用户歌单，找到"喜欢的音乐"
    const playlists = await music.playlistAll(loginInfo.uid);
    const likesPlaylist = playlists.find(p =>
      p.name === '喜欢的音乐' || p.name === 'LIKES' || p.name.includes('喜欢')
    );
    if (!likesPlaylist) {
      return res.json({ success: false, error: '未找到"喜欢的音乐"歌单', nickname: loginInfo.nickname });
    }

    // 获取全部歌曲
    const tracks = await music.playlistTracks(likesPlaylist.id);

    // 保存到数据库
    state.setPref('ncm_cookie', cookie.trim());
    state.setPref('fav_playlist_id', String(likesPlaylist.id));
    state.setPref('fav_playlist_name', likesPlaylist.name);
    state.setPref('fav_playlist_tracks', JSON.stringify(tracks));

    res.json({
      success: true,
      nickname: loginInfo.nickname,
      playlistName: likesPlaylist.name,
      trackCount: tracks.length,
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── 已导入歌单信息 ──
app.get('/api/imported-playlist', (req, res) => {
  const id = state.getPref('fav_playlist_id');
  const name = state.getPref('fav_playlist_name');
  const tracksJson = state.getPref('fav_playlist_tracks');
  if (!id) return res.json({ imported: false });
  let trackCount = 0;
  try { trackCount = JSON.parse(tracksJson || '[]').length; } catch {}
  res.json({ imported: true, id, name, trackCount });
});

// ── 启动时从数据库恢复 Cookie ──
const savedCookie = state.getPref('ncm_cookie');
if (savedCookie) {
  process.env.NCM_COOKIE = savedCookie;
  console.log('已从数据库恢复网易云 Cookie');
}

// ── 启动 ──
context.invalidateCache();
app.listen(3000, () => {
  console.log(`Claudio Agent 已在 3000 端口启动`);
  console.log(`模型: ${claude.MODEL}`);
  console.log(`工具: ${claude.BUILTIN_TOOLS.map(t => t.function.name).join(', ')}`);
});
