// ═══════════════════════════════════════════════════
//  Router — 三通道意图分流
//  设计哲学：明确 > 模糊，能不烧 Token 就不烧
//
//  cmd:   前缀指令 → 直连，0 Token
//  music: 关键词正则 → music.search()，1 API call
//  llm:   兜底自然语言 → Agent.chat()，n 轮 tool loop
// ═══════════════════════════════════════════════════

// ── 命令路由表 ──────────────────────────────────

const CMD_TABLE = [
  { pattern: /^\/play(?:\s+(.+))?/i,  action: "play",  extract: (m) => ({ query: m[1] ?? null }) },
  { pattern: /^\/pause/i,             action: "pause", extract: () => ({}) },
  { pattern: /^\/next/i,              action: "next",  extract: () => ({}) },
  { pattern: /^\/skip/i,              action: "next",  extract: () => ({}) },
  { pattern: /^\/now/i,               action: "now",   extract: () => ({}) },
  { pattern: /^\/weather/i,           action: "weather", extract: () => ({}) },
  { pattern: /^\/help/i,              action: "help",  extract: () => ({}) },
];

// ── 音乐关键词正则 ──────────────────────────────

const MUSIC_PATTERNS = [
  /放点\s*(.+)/,
  /放一首?\s*(.+)/,
  /我想听\s*(.+)/,
  /来[一首点]\s*(.+)/,
  /播[放放]?\s*(.+)/,
  /搜(?:索)?\s*(.+)/,
  /有没有\s*(.+)\s*的[歌曲]/,
  /听\s*(.+)\s*[吧吗]?$/,
];

const MUSIC_INTENT_ONLY = [
  /^(推荐|每日推荐|日推|随便来|随便听)/,
  /^(伤感的?|开心的?|安静的?|轻快的?|摇滚|爵士|古典|民谣|电子|嘻哈|说唱|R&B|钢琴|纯音)/,
  /^(适合|来点|想要)\s*(.+)/,
];

// ── 主分流函数 ──────────────────────────────────

/**
 * 将用户输入分流为三种意图。
 *
 * @param {string} text - 用户的原始输入
 * @returns {{ kind: 'cmd'|'music'|'llm', action: string, payload: Object, rawText: string }}
 *
 * payload 约定（按 kind）：
 *   cmd   → { query?: string }
 *   music → { keyword: string, source: 'explicit'|'intent' }
 *   llm   → { message: string }
 */
export function dispatch(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return { kind: "llm", action: "chat", payload: { message: text }, rawText: text };
  }

  // ── 通道 1：命令前缀（最快，0 Token）─────────
  for (const { pattern, action, extract } of CMD_TABLE) {
    const m = trimmed.match(pattern);
    if (m) {
      return { kind: "cmd", action, payload: extract(m), rawText: text };
    }
  }

  // ── 通道 2：音乐关键词（1 次 API）────────────
  for (const re of MUSIC_PATTERNS) {
    const m = trimmed.match(re);
    if (m) {
      const keyword = m[1]?.trim();
      if (keyword) {
        return {
          kind: "music",
          action: "search",
          payload: { keyword, source: "explicit" },
          rawText: text,
        };
      }
    }
  }

  // 纯意图匹配（没有具体歌名，"推荐" / 情绪词 / "适合"）
  for (const re of MUSIC_INTENT_ONLY) {
    if (re.test(trimmed)) {
      return {
        kind: "music",
        action: "recommend",
        payload: { keyword: trimmed, source: "intent" },
        rawText: text,
      };
    }
  }

  // ── 通道 3：自然语言 → LLM（兜底）───────────
  return { kind: "llm", action: "chat", payload: { message: text }, rawText: text };
}
