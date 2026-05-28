# Claudio — AI 音乐电台

一个基于大语言模型的智能音乐推荐系统。用户通过自然语言对话（如"来首安静的歌"），AI 自动搜索、推荐并播放音乐，模拟深夜电台主播的角色。

## 功能特性

- **自然语言对话** — 说"推荐点歌"、"放首爵士"、"我今天心情不好"即可触发推荐
- **智能工具调用** — AI 自主决策调用搜索、推荐、收藏等 11 个后端工具
- **流式打字机效果** — 基于 SSE 实现逐字输出，实时感强
- **个性化推荐** — 基于用户收藏品味 + 时段 + 天气自动调整推荐方向
- **中英双语** — 支持中英文切换，人格文件隔离，语言规则注入
- **语音合成** — Edge TTS 逐字时间戳同步，支持朗读 AI 回复
- **收藏管理** — 星标/红心同步，播放历史记录，过期链接自动刷新
- **PWA 支持** — 可添加到手机主屏幕，离线缓存

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | HTML5 / CSS3 / JavaScript / PWA / Web Audio API |
| 后端 | Node.js / Express / SQLite |
| AI | DeepSeek API / Tool Use（函数调用） |
| 音乐 | 网易云音乐 API |
| 语音 | Edge TTS (msedge-tts) |
| 通信 | SSE (Server-Sent Events) 流式传输 |

## 架构设计

```
用户输入 → Express 服务器 → 六盒 Prompt 组装 → DeepSeek AI
                                      ↓
                              工具调用循环（最多 3 轮）
                                      ↓
                         搜索/推荐/天气/收藏等 11 个工具
                                      ↓
                              SSE 流式回复 → 前端逐字显示
                                      ↓
                              音乐结果自动播放
```

### 六盒 Prompt 架构

将 system prompt 拆分为 6 个独立模块，按优先级拼装：

| 盒子 | 内容 | 优先级 |
|------|------|--------|
| BOX 1 | 系统人格（dj-persona.md） | 永远保留 |
| BOX 2 | 用户品味语料（taste.md） | 永远保留 |
| BOX 3 | 环境注入（时段 + 天气） | 永远保留 |
| BOX 4 | 对话记忆 + 播放历史 | 可截断 |
| BOX 5 | 当前用户输入 | 可截断 |
| BOX 6 | 执行轨迹 | 可截断 |

总 token 预算 8192，超出时按 BOX 6 → 4 → 5 的顺序截断。

## 项目结构

```
├── src/
│   ├── server.js        # Express 服务器，路由 + 工具注册
│   ├── claude.js        # DeepSeek API 封装，流式工具调用循环
│   ├── context.js       # 六盒 Prompt 组装引擎
│   ├── music.js         # 网易云音乐 API 封装
│   ├── tts.js           # Edge TTS 语音合成
│   ├── state.js         # SQLite 状态管理
│   └── scheduler.js     # 定时调度
├── pwa/
│   ├── index.html       # 主页面（播放器 + 对话 + 频谱）
│   ├── stream.js        # SSE 流式客户端
│   ├── style.css        # 样式（暗色/亮色主题）
│   └── manifest.json    # PWA 配置
├── prompts/
│   └── dj-persona.md    # AI 人格剧本
├── user/
│   ├── taste.md         # 用户音乐口味
│   └── routines.md      # 作息规律
└── data/
    └── state.db         # SQLite 数据库
```

## 本地运行

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（创建 .env 文件）
DEEPSEEK_API_KEY=your_key_here
NCM_COOKIE=your_netease_cookie

# 3. 启动服务器
node src/server.js

# 4. 打开浏览器
# 访问 http://localhost:3000
```

## 核心模块说明

### Tool Use 工具调用机制

AI 不直接访问数据，而是通过 11 个工具间接操作：

```
用户: "推荐点安静的歌"
  → AI 决策: 调用 recommend_music({ mood: "安静 深夜" })
  → 后端执行: 网易云推荐 + 私人 FM + 去重 + 品味排序
  → 结果喂回 AI
  → AI 生成自然语言回复 + 自动播放第一首歌
```

### SSE 流式通信

```
前端 → POST /api/chat → 后端
后端 → SSE 事件流 → 前端
  ├─ { type: "text", content: "深" }
  ├─ { type: "text", content: "夜" }
  ├─ { type: "tool_calls", calls: ["recommend_music"] }
  ├─ { type: "tool_result", name: "recommend_music", result: {...} }
  └─ { type: "done" }
```

### 防报时机制

多层防护防止 AI 在回复中播报时间：
1. 人格规则明确禁止
2. 环境注入中强调"严禁播报"
3. 对话历史中的时间词全部清洗删除

## 演示

Claudio 运行后打开 `http://localhost:3000`，可以看到：
- 暗色主题的电台界面，带实时时钟
- 底部输入框，输入自然语言即可对话
- AI 回复逐字打出，音乐自动播放
- 频谱动画随音乐跳动
- 支持收藏、播放历史、中英切换

## License

MIT
