const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROMPTS_DIR = path.join(ROOT, 'prompts');
const USER_DIR = path.join(ROOT, 'user');

// ── token 估算（中英混合粗估：~2.5 字符 / token）──

function estimateTokens(text) {
  return Math.ceil(text.length / 2.5);
}

// ── 带缓存的读文件 ──

const _cache = new Map();

function readCached(filePath, ttlMs = 300000) {
  const cached = _cache.get(filePath);
  if (cached && Date.now() - cached.ts < ttlMs) return cached.content;
  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    _cache.set(filePath, { content, ts: Date.now() });
    return content;
  } catch {
    return '';
  }
}

function invalidateCache(filePath) {
  if (filePath) {
    _cache.delete(path.resolve(filePath));
  } else {
    _cache.clear();
  }
}

// ── 六个盒子 ──

// ① 系统提示词
function boxPersona() {
  const raw = readCached(path.join(PROMPTS_DIR, 'dj-persona.md'));
  return raw || '你是一个电台主理人，根据用户心情推荐歌曲。';
}

// 导出时清除缓存
function clearPersonaCache() {
  invalidateCache(path.join(PROMPTS_DIR, 'dj-persona.md'));
}

// ② 用户语料：taste.md + routines.md + mood-rules.md
function boxUserCorpus() {
  const files = ['taste.md', 'routines.md', 'mood-rules.md'];
  return files
    .map((f) => readCached(path.join(USER_DIR, f)))
    .filter(Boolean)
    .join('\n\n');
}

// ③ 环境注入：时间 + 天气 + 未来 1h 日程
function boxEnv(deps) {
  const now = new Date();
  const h = now.getHours();
  let period = '深夜';
  if (h >= 7 && h < 9) period = '早晨通勤';
  else if (h >= 9 && h < 12) period = '上午工作';
  else if (h >= 12 && h < 14) period = '中午午休';
  else if (h >= 14 && h < 18) period = '下午工作';
  else if (h >= 18 && h < 20) period = '傍晚下班';
  else if (h >= 20 && h < 23) period = '晚上放松';
  else if (h >= 23 || h < 2) period = '深夜';
  else period = '凌晨';

  const parts = [
    `【当前时段: ${period}】根据此调整语气和推荐方向。严禁在回复中提及任何具体时间、数字、星期。即使对话历史中出现过时间，也不要模仿。`,
  ];
  if (deps.weather) parts.push(`【天气参考·严禁播报】${deps.weather}`);

  // 语言设置
  if (deps.state && deps.state.getPref) {
    const lang = deps.state.getPref('language');
    if (lang === 'en') {
      parts.push('【语言设置】You MUST respond in English. All replies, song introductions, and conversations must be in English. Do not use Chinese unless the user writes in Chinese.');
    }
  }

  return parts.join('\n');
}

// ④ 已检索记忆：最近对话 + 播放记录
function stripTimeReferences(text) {
  if (!text) return '';
  return text
    .replace(/[一二三四五六七八九十\d]{1,2}[点时:][一二三四五六七八九十\d]{0,2}[分]?/g, '')
    .replace(/(凌晨|早上|上午|中午|下午|傍晚|晚上|深夜)\s*[一二三四五六七八九十\d]/g, '')
    .replace(/(周|星期)[一二三四五六日天]/g, '')
    .replace(/[一二三四五六七八九十\d]{1,2}月[一二三四五六七八九十\d]{1,2}[日号]/g, '')
    .replace(/(晴|阴|雨|雪|多云|度|℃|°C)/g, '')
    .replace(/(这个|此时|此刻)(时刻|时间|时分)/g, '')
    .replace(/\s{2,}/g, ' ').trim();
}

function boxMemory(state, userId) {
  if (!state || !state.recent) return '';
  const { messages, plays } = state.recent({ messages: 10, plays: 30, userId });
  const lines = [];

  // 用户长期记忆（AI 主动保存的偏好/习惯）
  if (state.getUserNotes) {
    const notes = state.getUserNotes();
    if (notes.length) {
      lines.push('【用户记忆】');
      notes.forEach((n) => lines.push(`- ${n.text}`));
    }
  }

  if (messages.length) {
    lines.push('【最近对话】');
    messages.forEach((m) => {
      const content = m.role === 'assistant' ? stripTimeReferences(m.content) : m.content;
      lines.push(`[${m.role}] ${content}`);
    });
  }
  if (plays.length) {
    lines.push('【最近播放】');
    plays.forEach((p) => lines.push(`${p.song_name} - ${p.artist}`));
  }
  return lines.join('\n');
}

// ⑤ 用户输入 + NCM 候选歌曲
function boxInput(intent) {
  const parts = [`【用户输入】${intent.text}`];
  if (intent.ncmCandidates && intent.ncmCandidates.length) {
    parts.push('【NCM 候选歌曲】');
    intent.ncmCandidates.forEach((s, i) =>
      parts.push(`${i + 1}. ${s.name || s.id} - ${s.artist || '未知'} (id: ${s.id})`)
    );
  }
  return parts.join('\n');
}

// ⑥ 执行轨迹：触发来源
function boxTrace(intent, planSegment) {
  const parts = [`触发来源: ${intent.source || 'chat'}`];
  if (planSegment) parts.push(`当前节目段: ${planSegment}`);
  return parts.join('\n');
}

// ── 组装算法 ──

const MAX_TOKENS = 8192;

function build(intent, userId = 'default', deps = {}) {
  const { state, weather, calendar, planSegment } = deps;

  // 按 README 顺序：①→⑥
  const allBoxes = [
    { id: 1, label: 'system',     content: boxPersona(),                              stable: true },
    { id: 2, label: 'user_corpus', content: boxUserCorpus(),                           stable: true },
    { id: 3, label: 'env',        content: boxEnv({ weather, calendar }),              stable: false },
    { id: 4, label: 'memory',     content: boxMemory(state, userId),                   stable: false },
    { id: 5, label: 'input',      content: boxInput(intent),                           stable: false },
    { id: 6, label: 'trace',      content: boxTrace(intent, planSegment),              stable: false },
  ];

  const systemPrompt = assemblePrompt(allBoxes);

  // 组装消息：system + 最近对话历史 + 当前用户输入
  const messages = [
    { role: 'system', content: systemPrompt },
  ];

  // 加入最近的对话历史（最多 20 条，保持上下文连贯）
  if (state && state.recentMessages) {
    const history = state.recentMessages(20, userId);
    for (const m of history) {
      // 过滤掉助手回复中的时间播报，防止模型模仿
      if (m.role === 'assistant') {
        const cleaned = stripTimeReferences(m.content || '');
        messages.push({ role: 'assistant', content: cleaned || m.content });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }
  }

  // 当前用户输入
  messages.push({ role: 'user', content: intent.text });

  return {
    systemPrompt,
    messages,
    boxes: allBoxes.map((b) => ({ id: b.id, label: b.label, length: b.content.length })),
  };
}

function assemblePrompt(boxes) {
  let budget = MAX_TOKENS;
  const parts = [];

  // ①②③ 永远保留，先加入
  const preserved = boxes.filter((b) => b.id <= 3);
  for (const b of preserved) {
    if (!b.content) continue;
    parts.push(`<!-- BOX ${b.id} ${b.label} -->\n${b.content}`);
    budget -= estimateTokens(b.content);
  }

  // ④⑤⑥ 按 trim 优先级排序加入（截断顺序: ⑥→④→⑤）
  const trimOrder = { 6: 0, 4: 1, 5: 2 };
  const dynamic = boxes
    .filter((b) => b.id > 3 && b.content)
    .sort((a, b) => (trimOrder[a.id] ?? 9) - (trimOrder[b.id] ?? 9));

  for (const b of dynamic) {
    let text = b.content;
    let tokens = estimateTokens(text);

    if (tokens > budget) {
      text = truncateBox(text, budget, b.id);
      tokens = estimateTokens(text);
    }

    parts.push(`<!-- BOX ${b.id} ${b.label} -->\n${text}`);
    budget -= tokens;
  }

  return parts.join('\n\n');
}

function truncateBox(text, tokenBudget, boxId) {
  const maxChars = Math.floor(tokenBudget * 2.5);
  if (text.length <= maxChars) return text;

  if (boxId === 4) {
    // 记忆：保留尾部（最近的内容）
    return '...(较早内容已截断)\n' + text.slice(-maxChars + 15);
  }
  // ⑤⑥：保留头部
  return text.slice(0, maxChars - 15) + '\n...(已截断)';
}

module.exports = { build, invalidateCache, estimateTokens, boxPersona, boxUserCorpus, boxEnv, boxMemory, boxInput, boxTrace };
