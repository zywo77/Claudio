const { OpenAI } = require('openai');
require('dotenv').config();

const USE_DEEPSEEK = process.env.USE_DEEPSEEK === 'true';

const client = new OpenAI({
  apiKey: USE_DEEPSEEK
    ? process.env.DEEPSEEK_API_KEY
    : process.env.MIMO_API_KEY,
  baseURL: USE_DEEPSEEK
    ? 'https://api.deepseek.com/v1'
    : process.env.MIMO_BASE_URL,
});

const MODEL = USE_DEEPSEEK
  ? (process.env.DEEPSEEK_MODEL || 'deepseek-chat')
  : (process.env.MIMO_MODEL || 'mimo-v2.5-pro');

// ── 内置工具定义（MiMo 可调用） ──

const BUILTIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_music',
      description: '搜索网易云音乐歌曲，获取候选歌曲列表',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词，如歌名、歌手、风格、情绪' },
          limit:  { type: 'number', description: '返回数量，默认 4' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recommend_music',
      description: '根据用户偏好获取个性化推荐歌曲',
      parameters: {
        type: 'object',
        properties: {
          mood:  { type: 'string', description: '当前情绪或场景，如"雨天""通勤""放松"' },
          limit: { type: 'number', description: '返回数量，默认 4，最多 4' },
        },
        required: ['mood'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '获取指定城市的实时天气',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名，如"北京"' },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar',
      description: '获取用户今日日程安排',
      parameters: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: '查询未来 N 小时，默认 2' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'personal_fm',
      description: '获取私人FM推荐歌曲（基于用户听歌习惯的实时推荐）',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recent_songs',
      description: '获取用户最近播放的歌曲记录，了解用户口味偏好',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_user_taste',
      description: '获取用户收藏歌单的歌曲列表，用于分析用户音乐口味和偏好。当你需要了解用户喜欢什么风格、什么歌手时调用。推荐歌曲前应先调用此工具了解用户口味。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_favorites',
      description: '在用户的收藏歌单（喜欢的音乐）中搜索歌曲。当用户说"在我的收藏里找"、"收藏夹里有没有"、"我喜欢的歌里"等时使用。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词，如歌名、歌手名' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_user_note',
      description: '保存用户的重要偏好、习惯或个人信息到长期记忆。当用户表达明确的音乐偏好、生活习惯、情绪规律、对推荐的反馈等时调用。例如用户说"我最近喜欢听爵士"、"别给我推荐中文歌"、"我周一心情不好"等。note 应该是简洁的一句话总结。',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: '要记住的内容，简洁一句话' },
        },
        required: ['note'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_language',
      description: '切换对话语言。当用户说"用英文"、"说英文"、"switch to English"、"改中文"、"说中文"等时调用。',
      parameters: {
        type: 'object',
        properties: {
          lang: { type: 'string', enum: ['zh', 'en'], description: '语言代码：zh=中文，en=英文' },
        },
        required: ['lang'],
      },
    },
  },
];

// ── 工具执行注册表 ──

const toolExecutors = new Map();

function registerTool(name, handler) {
  toolExecutors.set(name, handler);
}

async function executeToolCall(name, args) {
  const fn = toolExecutors.get(name);
  if (fn) {
    try {
      return await fn(args);
    } catch (e) {
      return { error: e.message };
    }
  }
  return { error: `工具 "${name}" 未注册，请告知用户该功能暂不可用` };
}

// ── 工具调用循环（非流式） ──

async function chat(messages, { tools = [], maxRounds = 4 } = {}) {
  const allTools = [...BUILTIN_TOOLS, ...tools];
  const msgs = [...messages];
  let round = 0;

  while (round < maxRounds) {
    round++;
    const resp = await client.chat.completions.create({
      model: MODEL,
      messages: msgs,
      tools: allTools.length ? allTools : undefined,
      tool_choice: allTools.length ? 'auto' : undefined,
    });

    const msg = resp.choices[0].message;
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { content: msg.content, messages: msgs };
    }

    // 执行工具调用并喂回结果
    msgs.push(msg);
    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments || '{}');
      const result = await executeToolCall(tc.function.name, args);
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }

  // 达到最大轮次，强制收束
  const final = await client.chat.completions.create({ model: MODEL, messages: msgs });
  return { content: final.choices[0].message.content, messages: msgs };
}

// ── 流式聊天（Tool Use + Stream） ──

async function* chatStream(messages, { tools = [], maxRounds = 3 } = {}) {
  const allTools = [...BUILTIN_TOOLS, ...tools];
  const msgs = [...messages];
  let round = 0;
  let anyTextYielded = false;

  while (round < maxRounds) {
    round++;
    const isLastRound = round >= maxRounds;
    const useTools = !isLastRound && allTools.length > 0;

    const stream = await client.chat.completions.create({
      model: MODEL,
      messages: msgs,
      tools: useTools ? allTools : undefined,
      tool_choice: useTools ? 'auto' : undefined,
      stream: true,
    });

    const toolCalls = new Map();
    let hasToolCalls = false;
    let roundText = '';

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        roundText += delta.content;
        anyTextYielded = true;
        yield { type: 'text', content: delta.content };
      }

      if (delta.tool_calls) {
        hasToolCalls = true;
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = toolCalls.get(idx) || { id: '', name: '', arguments: '' };
          if (tc.id)                  cur.id = tc.id;
          if (tc.function?.name)      cur.name += tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          toolCalls.set(idx, cur);
        }
      }
    }

    if (!hasToolCalls) return;
    if (isLastRound) return;

    const tcArray = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v);

    yield { type: 'tool_calls', tool_calls: tcArray };

    // 写入 assistant 消息（可能有文字 + 工具调用）
    const assistantMsg = { role: 'assistant', tool_calls: tcArray.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }))};
    if (roundText) assistantMsg.content = roundText;
    msgs.push(assistantMsg);

    // 执行工具
    for (const tc of tcArray) {
      const args = JSON.parse(tc.arguments || '{}');
      const result = await executeToolCall(tc.name, args);
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      yield { type: 'tool_result', name: tc.name, result };
    }

    // 如果这一轮只有工具调用没有文字，注入提醒强制下一轮输出文字
    if (!roundText) {
      msgs.push({
        role: 'system',
        content: '工具已执行完毕。现在请直接回复用户，用自然语言总结结果。不要再调用任何工具。',
      });
    }
  }
}

module.exports = { chat, chatStream, registerTool, BUILTIN_TOOLS, MODEL };
