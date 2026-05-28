🎙️ Claudio 项目架构
一句话定位
个人 AI 电台：Claude 读懂你的听歌习惯 → 规划声音 → 像 DJ 一样播报。

整体三件套（来自图 2）
播放器界面（PWA / web app / localhost 都行）
本地服务器（Node.js，做所有事的"中枢"）
几个 API 协同：Claude 做大脑、网易云负责音乐、Fish Audio 做语音合成、飞书读日程、OpenWeather 接天气、UPnP 推音乐到家庭音响
四层架构（来自图 1）
层 职责
第一层 · 外部上下文 用户语料文件 + Claude Code + Music API + Voice/IO API
第二层 · 本地大脑 router · context · claude · scheduler · tts · state
第三层 · 运行时聚合 Context Window：6 片 prompt 拼装 + 模型前向
第四层 · 交互表层 PWA + HTTP/WS 接口契约
📁 一、项目目录结构

claudio/
├── prompts/
│ └── dj-persona.md # ① 系统提示词（DJ 人设）
│
├── user/ # 第一层：用户品味语料（让 Claudio "属于你"）
│ ├── taste.md # 音乐口味（喜欢/不喜欢、风格、年代）
│ ├── routines.md # 作息规律（起床/通勤/工作/睡前）
│ ├── playlists.json # 收藏歌单的结构化快照
│ └── mood-rules.md # 情绪规则（雨天放什么、加班放什么）
│
├── cache/
│ └── tts/ # TTS 合成结果，按 hash 命名
│ └── <hash>.mp3
│
├── data/
│ └── state.db # SQLite：messages / plays / plan / prefs（跨重启持久化）
│
├── src/ # 第二层：本地大脑（Node.js）
│ ├── server.js # HTTP/WS 入口，挂载 6 条 API 路由
│ ├── router.js # ❶ 意图分流
│ ├── context.js # ❷ Prompt 6 盒子组装
│ ├── claude.js # ❸ 大脑适配器（spawn `claude -p --output json`）
│ ├── music.js # ❹ NeteaseCloudMusicApi 封装
│ ├── tts.js # ❺ Fish Audio 声音管线
│ ├── scheduler.js # ❻ 节律调度（07:00/09:00/小时情绪 hook）
│ ├── state.js # ❼ SQLite 读写
│ └── integrations/
│ ├── feishu.js # 飞书：读日历/日程
│ ├── weather.js # OpenWeather：当前天气
│ └── upnp.js # UPnP：音乐推到 Naim/家庭音响
│
├── pwa/ # 第四层：交互表层
│ ├── index.html # 单 <audio> + 三视图（Player/Profile/Settings）
│ ├── sw.js # Service Worker，10s prefetch 缓存
│ └── stream.js # WebSocket 流式聊天客户端
│
├── .env
├── package.json
└── README.md
关键设计点：user/*.md 是用户的"语料"——这几个文件让 Claudio 真正属于个人；prompts/ 是系统侧人设；两者在第三层被 context.js 拼装到同一个 Prompt 里。

🔀 二、router.js —— 意图分流
设计哲学
"简单指令直连，自然语言走 Claude，音乐走 NCM" —— 不要让所有请求都过大模型，能本地解决的就直连，省 Token、省延迟。

三条分流通道

用户输入
│
▼
┌─ 1) 命令前缀匹配（最快）──────────┐
│ /play、/pause、/next、/skip │ → 直接调 player（不走 LLM）
│ /weather、/now │ → 直接调对应 integration
└──────────────────────────────────┘
│（未命中）
▼
┌─ 2) 关键词正则匹配（音乐意图）────┐
│ "放点 X"、"我想听 Y"、 │
│ "来首 Z"、歌名/歌手识别 │ → 直接走 music.search → music.songUrl
└──────────────────────────────────┘
│（未命中）
▼
┌─ 3) 兜底走 Claude（自然语言）─────┐
│ "今天有点累"、"帮我安排早间" │ → context.build() → claude.spawn()
│ "讲讲这首歌的故事" │ 解析返回的 {say, play[], reason, segue}
└──────────────────────────────────┘
router.js 内部状态机
输入：{ text, source: 'chat'|'cron'|'webhook', userId }
输出：统一的 Intent 对象 — { kind: 'cmd'|'music'|'llm', payload, meta }
副作用：把意图记录到 state.db 的 messages 表，方便后续上下文回放
路由优先级要点
明确 > 模糊：先 cmd，后 music，最后 LLM
可取消：每条意图带超时（cmd 1s / music 3s / llm 30s）
降级链：LLM 失败 → 回退到本地随机推荐（基于 user/playlists.json）
🧩 三、context.js —— 6 个 Prompt 盒子怎么粘
"组装盒子 · 每次触发按这 6 片粘成 prompt" —— 这是图中第三层的核心，对应运行时聚合。

6 个盒子（对应图中 ①~⑥）
# 盒子名 来源 作用
① 系统提示词 prompts/dj-persona.md 定义 Claudio 的人设、说话风格、JSON 输出格式
② 用户语料 user/*.md（taste/routines/mood-rules） 个人品味、作息、情绪偏好
③ 环境注入 weather + calendar + now（实时） 当前时间、天气、未来 1 小时日程
④ 已检索记忆 state.db 的 messages + plays 最近 N 条对话、最近 M 首播放历史（防止重复推荐）
⑤ 用户输入 / 工具结果 /api/chat + ncm search 返回 当前请求 + 已经从 NCM 拿到的候选歌曲
⑥ 执行轨迹 scheduler + webhook 事件流 这次触发是哪种来源（用户主动 vs cron 定时 vs hook）
组装算法（伪代码思路）

function build(intent, userId):
pieces = []
① pieces.push(read('prompts/dj-persona.md')) // 不变
② pieces.push(concat('user/taste.md','routines.md','mood-rules.md')) // 偶尔变
③ pieces.push(snapshot({ now, weather, today_calendar })) // 每分钟变
④ pieces.push(state.recent({ messages: 10, plays: 30 })) // 每次变
⑤ pieces.push({ user_input: intent.text, ncm_candidates }) // 每次变
⑥ pieces.push({ trigger: intent.source, plan_segment }) // 每次变
return assemblePrompt(pieces) // 拼接 + 插分隔符 + 截断到 token 上限
关键设计要点
稳定优先级：①② 永远在最前（缓存友好，可被 prompt cache 命中）
变化部分靠后：③④⑤⑥ 越往后越易变（避免缓存频繁失效）
截断策略：超 token 时按⑥→④→⑤的顺序裁，①②③ 永远保留
JSON 契约：⑤里明确告诉 Claude "返回 {say, play[], reason, segue}"
期望模型输出

{
"say": "早上好，今天北京有点阴，给你放首暖一点的钢琴...",
"play": ["song_id_1", "song_id_2"],
"reason":"你昨天加班到 11 点，今早不适合电子",
"segue": "听完这两首，9 点你有个会，我会自动暂停。"
}
say 进 tts.js 合成语音
play 进 music.js 解析直链
segue 喂回 ⑥ 作为下次触发的轨迹
🎵 四、music.js 核心函数（NeteaseCloudMusicApi 封装）
函数 输入 输出 用途
search(keyword, opts) 关键词 + 类型 候选歌曲列表（id/name/artist/album） 给 router 和 LLM 提供候选
songUrl(id) 歌曲 ID 直链 mp3 URL 喂给 player 或 UPnP
lyric(id) 歌曲 ID LRC 文本 给 LLM 解读、给 PWA 同步显示
recommend(userId) 用户上下文 个性化推荐列表 早间/通勤启动时的种子池
detail(ids[]) 一批歌曲 ID 元信息（时长/封面/年代） 拼装 plan 时显示给用户
playlistAll(uid) 网易云 UID 用户全部歌单（拉一次写到 user/playlists.json） 启动时同步个人品味
缓存策略
songUrl 直链有时效，每次现拉
search/lyric/detail 写 SQLite 缓存（24h TTL）
playlistAll 仅手动触发同步（避免被风控）
错误处理
网络失败 → 返回 { error: 'ncm_unreachable' }，让 LLM 知道无候选可用
版权下架 → 标记 available: false，跳过这首继续下一首
🗣️ 五、tts.js 核心函数（Fish Audio 声音管线）
图中标注的管线流向：Fish Audio → cache/tts/*.mp3 → /tts/<hash>.mp3

函数 输入 输出 用途
synth(text, voiceId) 文本 + 音色 ID 本地 mp3 路径（带 hash 命名） 把 LLM 的 say 转成声音
cacheKey(text, voiceId) 同上 sha1 hash 字符串 决定缓存文件名，相同文本不重复合成
serve(hash) hash HTTP 流式返回 mp3 /tts/<hash>.mp3 路由的实现
prewarm(scriptList) 一组待播报文本 void scheduler 提前 10s 预合成，避免播放时卡顿
cleanup(maxAgeDays) 天数阈值 清理数 定期清旧缓存（默认 7 天）
关键设计要点
Hash 命名 = 自动去重：hash(text + voiceId) 作为文件名，相同播报不会反复调 Fish Audio API（省钱）
流式吐字：serve() 用 Transfer-Encoding: chunked，前端 <audio> 边下边播
管线衔接：

LLM 返回 say
↓
synth(say) → 写到 cache/tts/<hash>.mp3
↓
PWA <audio src="/tts/<hash>.mp3"> 边下边播
↓
播完触发 next event → music.js 接力放歌
预热触发点：scheduler 在 07:00 早间任务规划好后，立刻 prewarm 早间播报，09:00 触发时直接秒播
🔁 六、运行时数据流（串起来看）

用户在 PWA 里说"放点雨天的歌"
│
▼
┌── PWA → POST /api/chat ──┐
▼ ▼
router.js state.js
(识别为音乐意图) (写入 messages)
│
├──► music.search("rain mood") → 拿到候选列表
│
▼
context.js
(① dj-persona + ② taste/mood-rules + ③ 当前在下雨
+ ④ 最近播放 + ⑤ 用户输入+候选歌 + ⑥ chat 触发)
│
▼
claude.js → spawn `claude -p --output json`
│
▼
{say, play[], reason, segue}
│
├──► tts.synth(say) → cache/tts/<hash>.mp3
├──► music.songUrl(play[]) → 直链
├──► state.plays.append()
│
▼
PWA 通过 WS /stream 收到事件：
now-playing / next / lyric
│
▼
<audio> 串播 [tts.mp3, song1, song2]
│
▼
（可选）upnp.push 到 Naim 家庭音响
🌐 七、HTTP 契约（图中第四层右侧）
方法 路径 作用
POST /api/chat 用户聊天/点歌入口
GET /api/now 当前正在播什么
GET /api/next 下一首预告
GET /api/taste 读用户品味（设置页用）
GET /api/plan/today 今日整套节目单
WS /stream 流式推送：tts/play/lyric/segue 事件
🎯 实现优先级建议
如果你要从 0 开始搭，推荐顺序：

第一周：server.js + state.js + music.js（先打通：能搜歌、能拿直链、能在浏览器放出来）
第二周：claude.js + context.js（先用最简单的 prompt，跑通 LLM 返回 JSON 的链路）
第三周：tts.js + PWA 串播（让它"开口说话"）
第四周：scheduler.js + routines.md（让它按时间自动启动，从"对话工具"变"电台"）
后续：UPnP 推音响、飞书读日程、weather 联动
如果你想，我可以帮你直接生成 prompts/dj-persona.md 和 user/taste.md 的模板，或者先把 router.js + context.js 的骨架代码搭起来。