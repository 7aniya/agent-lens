# AgentLens · AI Agent 执行过程可视化控制台

> 把「黑盒」的 Agent 调用变成可观察、可复盘、可解释的过程。
>
> 一个面向 AI 应用开发的**前端工程化**项目：规划可视化 + 工具调用链路 + RAG 检索可观测 + 执行流录制。

<p>
  <img alt="React" src="https://img.shields.io/badge/React-18-087ea4?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.6-3178c6?style=flat-square" />
  <img alt="Vite" src="https://img.shields.io/badge/Vite-5-646cff?style=flat-square" />
  <img alt="ECharts" src="https://img.shields.io/badge/ECharts-5-aa344d?style=flat-square" />
  <img alt="License" src="https://img.shields.io/badge/License-MIT-3b6d11?style=flat-square" />
</p>

| 执行流 + 收益测算 | RAG 检索与工具调用链路 |
| :---: | :---: |
| ![AgentLens 深色主题](docs/screenshot-dark.png) | ![AgentLens 浅色主题](docs/screenshot-light.png) |

---

## 这个项目解决什么问题

做 AI 应用时，最痛苦的不是「调不通模型」，而是**调通了但不知道为什么**：

- 用户问了一个问题，模型答错了。是**检索没召回**？**提示词没说清**？还是**模型能力边界**？
- Agent 执行了 5 轮工具调用，中间哪一轮耗时最长？哪一轮参数传错了？
- 这次改完提示词效果变好了，**上一次的链路长什么样**？想对比，但没留证据。

大多数 AI 应用的界面只给一个输入框和一个回答框 —— 中间发生了什么，全靠猜。

**AgentLens 把中间过程全部摊开**：规划步骤、每一条推理、每一次工具调用的入参出参与耗时、RAG 命中的切片与相关度分数、token 消耗与端到端耗时，并且把整条链路录下来供复盘。

---

## 功能

### 1. 任务规划可视化
Agent 先把目标拆解成有先后顺序的步骤，每一步的状态（待执行 / 执行中 / 已完成 / 失败）实时更新，并标注该步骤绑定的工具与耗时。

### 2. 执行流实时渲染
推理过程与最终回答分开呈现，工具调用、RAG 检索结果、图表按**真实发生顺序**交织在主执行流里，而不是分散在几个面板中。

### 3. RAG 全链路可观测
- 文档 → 切分（段落优先 + 长度兜底 + 重叠）→ 建索引 → BM25 打分 → topK
- 每条命中展示：来源文档、切片 ID、相关度分数、命中上下文片段
- 支持上传自己的 `txt / md / csv / json`，索引立即重建

### 4. 工具调用链路
每个工具调用是一张可展开的卡片：入参 JSON、返回结果、执行状态、耗时。失败时红框高亮，错误信息直接可见。

### 5. 可观测性指标
总耗时、工具调用次数、RAG 检索次数、工具累计耗时、输入/输出 token、**工具调用甘特图**、**步骤耗时排行**、运行日志。

### 6. 双运行模式
| 模式 | 特点 | 适用场景 |
| --- | --- | --- |
| **Mock 离线** | 无需 API Key、结果确定可复现、完全离线 | 演示、自测、录屏 |
| **真实模型** | 接入任意 OpenAI 兼容接口 | 真实业务验证 |

> 关键设计：Mock 模式调用的是**真实工具实现**，所以检索分数、计算结果、图表数据都是真实产生的，只有「模型措辞」是模板化的。

**关于模式回退**：选择「真实模型」但 API Key 为空时，运行时不会报错中断，而是回退到 Mock 继续跑完。这是刻意的——演示场合不该因为没配 Key 就白屏。

但「静默回退」会造成一个很糟糕的误判：用户切了模式，跑完发现结果和 Mock 一模一样，于是认为切换功能坏了。所以回退被做成了**一等事件**（`mode_fallback`），并在三处同时暴露：

1. 顶部提示条明确写出「本次运行并未使用真实模型」以及原因；
2. 右上角模式标识显示实际行为（`缺 Key · 实际跑 Mock`），且可直接点击去填写；
3. 运行日志保留一条 warn 记录。

模式标识读取的是 `run_start` 事件里的 `mode`，也就是**本次运行实际用了什么**，而不是设置里选了什么——两者可能不一致，界面必须以后者为准。

**设置面板按模式收敛**：Mock 模式不发任何网络请求，模型配置对它毫无意义。所以设置面板里「模型配置」区在 Mock 模式下默认收起，只留一句说明和两个入口（「切换到真实模型并配置」/「先填好 Key」）；切到真实模型后自动展开，切回 Mock 自动收起。若在 Mock 下手动展开，顶部会插入一条提示说明配置尚不生效。同理，「演示速度」在真实模型模式下置灰——流式速度由服务端决定。

这类"模式 A 用不到的东西在模式 B 里照旧全摆着"的设计，会让用户误判成功能没生效。**一个控件要么生效，要么显式说明为什么不生效，不能悬在中间。**

**失败必须可诊断**：真实模型最常见的失败不是"代码坏了"，而是 Key、模型名、跨域三处配置问题。而浏览器抛出的原文（`Failed to fetch`）没有任何信息量——所以适配层把所有失败统一转成带上下文的说明，并提到主区域展示，而不是埋在运行日志里。

| 失败类型 | 界面标题 | 附带信息 |
| --- | --- | --- |
| HTTP 4xx / 5xx | 模型请求失败：HTTP 401 | 请求地址、模型名、服务端错误码与原文、按状态码给出的排查建议；401/403 另附 **Key 自检** |
| 请求头/地址含非法字符 | 请求未能发出：请求地址或请求头里含有非法字符 | 定位到是粘贴内容里混进了换行，而不是网络或跨域问题 |
| 请求未发出（多为跨域） | 请求未能发出：浏览器在发送前就中断了这次调用 | 说明此时服务端不会有任何记录，先确认接口能否直连 |
| 响应非 JSON | 服务端返回的内容不是合法 JSON | 响应开头片段，提示 Base URL 可能指向了网页而非接口 |

**401 不该只丢一句「身份验证失败」**。它的成因高度集中在四件事上：复制不全、混进空白字符、拿错平台的 Key、Key 已被撤销。所以除了服务端原文，还会把本机这份 Key 的实际形态摊开给用户看——密码框里看不见的东西，得让它在别处可见：

```
已填写 29 个字符，前 6 位 sk-abc，后 4 位 wxyz——与控制台显示的长度和首尾核对一下
Key 中间含空格或换行，几乎可以确定是复制时多选了内容
当前接口属于 智谱开放平台（open.bigmodel.cn），该平台的 Key 形如 xxxxxxxx.yyyyyyyy
以 sk- 开头的 Key 一般来自 OpenAI / DeepSeek / 硅基流动 / 百炼，不是智谱的格式
```

这套判断是纯本地的静态检查，不联网、不上传。发送前还会统一剥掉零宽字符与空白——**Key 里混进一个换行，`fetch` 会直接拒绝构造请求并抛 `Invalid value`，现象像跨域、实际是粘贴问题**，不单独识别出来就会被误导去折腾 CORS。

| ![设置面板里的 Key 自检](docs/screenshot-key-check.png) | ![运行失败详情](docs/screenshot-error-detail.png) |
| --- | --- |
| 设置面板：填完 Key 立刻能看到它的长度与首尾片段 | 运行失败：状态码、服务端错误码、Key 自检三段合一 |

设置面板的**测试连接**按钮发一次最小请求，把「配置能不能用」和「配置错在哪」分开——不必跑完整个 Agent 才能定位问题。

此外有两处协议细节属于"本地能跑、换个服务就报错"的类型，也一并处理了：

1. 带 `tool_calls` 的 assistant 消息，`content` 必须是 `null` 而不是空字符串——OpenAI 官方实现能容忍空串，智谱等严格实现会直接 400；
2. 部分模型（如开启深度思考的 GLM Flash）把内容放在 `reasoning_content`，`content` 为空时需要回退取值，否则强依赖正文的规划环节会拿到空串。

### 7. 运行记录与复盘
每次运行结束后自动归档完整事件序列，点击可还原当时的执行现场。

每条记录末尾提供删除按钮。**「历史运行」抽屉与右侧可观测性面板各有一份记录列表，展示的是同一份数据，因此共用同一个删除组件**——两处都显示记录、却只有一处能删，用户会误认为另一处的记录删不掉。

单条删除只影响列表本身；若被删的这条正被回放展示，当前视图保持不动（回放的是快照，与是否留底无关）。

### 8. 深色 / 浅色主题
通过 CSS 变量切换，图表配色同步跟随。

### 9. 窄屏适配
≤1140px 时三栏改为单列堆叠。由于堆叠后总高度远超一屏，目标输入框会被挤出视口，因此窄屏下把它固定在视口底部常驻；「任务规划」空状态里另提供了一个直接跳到输入框的入口。

---

## 快速开始

```bash
git clone https://github.com/<your-name>/agent-lens.git
cd agent-lens
npm install
npm run dev
```

打开 http://localhost:5173 即可。**默认是 Mock 模式，不需要任何 API Key。**

### 接入真实模型

点击右上角 **设置** → 运行模式选「真实模型」。设置面板内置了 7 个预设，**点一下自动填好 Base URL 与模型名**，你只需要填 Key：

| 服务 | Base URL | 推荐模型 | 免费政策 | 浏览器直连 |
| --- | --- | --- | --- | --- |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.7-flash` | **永久免费**（200K 上下文，支持工具调用） | ✅ |
| 智谱 GLM（轻量） | 同上 | `glm-4.5-flash` | **永久免费**，延迟更低 | ✅ |
| 魔搭 ModelScope | `https://api-inference.modelscope.cn/v1` | `Qwen/Qwen3-8B` | 每日 2000 次，每日重置 | ✅ |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-8B` | 注册赠 2000 万 token；9B 以下永久免费 | ✅ |
| OpenRouter | `https://openrouter.ai/api/v1` | `qwen/qwen3.8-27b:free` | 16 个 `:free` 模型，有每日次数上限 | ✅ |
| 阿里百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 新用户赠千万级 token | ✅ |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | 注册赠额度，用完后单价极低 | ✅ |

统一只依赖 OpenAI 的 `/chat/completions` 协议，换服务商不用改代码。

> **关于「浏览器直连」这一列**：上表结果由 `OPTIONS` 预检请求实测得出（2026-09）。
> 未开放 CORS 的接口（例如 z.ai 国际站）前端会直接被浏览器拦截，需要走服务端代理。
> 这类接口的实际表现是请求根本没发出去、控制台报 CORS 错误，而不是返回 4xx ——
> 排查时容易误判成鉴权问题，所以我把实测结果直接标在界面上。
>
> API Key 仅保存在浏览器 `localStorage`，不会上传到任何服务器。
> 若需要把 Key 藏到服务端，可使用仓库内 `api/llm-proxy.ts`（见下方「部署」）。

---

## 架构设计

### 核心：Agent 运行时是一个异步事件流

```
runAgent(goal, ctx) : AsyncGenerator<AgentEvent>
```

规划、推理、工具调用、检索、流式 token 全部以事件形式抛出。UI 只做一件事：把事件渲染出来。

这个设计带来三个直接收益：

1. **UI 与推理内核完全解耦** —— 换成别的推理后端，前端一行不用改
2. **事件流天然可录制** —— 存下来就是一条可回放的链路
3. **中断干净** —— `AbortSignal` 在任意 `await` 点都能退出

```
src/
├── agent/                 推理内核（与 React 完全无关，可独立复用）
│   ├── types.ts           AgentEvent / PlanNode / ToolCall / ChartSpec 等契约
│   ├── corpus.ts          内置示例知识库
│   ├── retrieval.ts       切分 + BM25 检索
│   ├── tools.ts           工具注册表（新增工具只改这里）
│   ├── planner.ts         Mock 规划器 + LLM 规划器
│   ├── llm.ts             OpenAI 兼容协议适配层
│   └── runtime.ts         Agent 运行时（事件流）
├── hooks/
│   └── useAgentRun.ts     事件 → 状态，中断控制，耗时计时
├── components/            纯展示组件
└── state.tsx              useReducer + Context 状态层
```

### 一次运行的完整链路

```
用户输入目标
   ↓
① 规划          planner 产出 PlanNode[]           → plan 事件
   ↓
② 逐步执行      每步设 running / done              → node_status 事件
   ├─ 推理       流式吐出推理文本                    → message_start / message_delta
   ├─ 工具调用   入参出参 + 耗时                     → tool_call / tool_result
   ├─ RAG 检索   命中切片 + 相关度                   → retrieval 事件
   └─ 数据可视化 工具返回结构化数据，UI 自动绘图      → chart 事件
   ↓
③ 汇总回答      流式输出最终答案                    → message_delta
   ↓
④ 计量          输入/输出 token                    → usage 事件
   ↓
⑤ 归档          完整事件序列存入历史               → run_end 事件
```

---

## 设计取舍

这些取舍是刻意的，也欢迎讨论：

**① 为什么用 BM25 而不是向量检索？**
向量检索需要 embedding 模型，要么依赖后端、要么依赖 API Key，会让「clone 下来就能跑」这个目标失效。BM25 是纯计算、零依赖的，中文场景按二元组切分效果可接受，足以让使用者看清「检索 → 排序 → 拼装」这条链路。**生产环境应替换为「向量粗召 + 重排序」的两阶段链路**，接入点就是 `retrieval.ts` 的 `search()`。

**② 为什么内置一份语料？**
一个 RAG Demo 如果必须先上传文档才能体验，门槛就太高了。内置语料让项目开箱即用，同时支持覆盖。

**③ 为什么自己写 Markdown 渲染器？**
只支持标题、列表、粗体、行内代码四种语法。为四种语法拉进 `marked` + `dompurify` 两棵树不划算，自己实现反而让渲染逻辑本身成为可读示例。

**④ 为什么不用 Redux / Zustand？**
AgentLens 的状态变化几乎全部来自单一来源（Agent 事件流），`useReducer` 已经足够，且能让使用者一眼看懂数据怎么流动。依赖表里只有 `react`、`react-dom`、`echarts` 三个运行时依赖。

**⑤ 为什么 echarts 按需引入？**
`import * as echarts from 'echarts'` 会把所有图表类型打进包里。本项目只用折线和柱状，通过 `echarts/core` + 按需注册可以省掉一半以上体积。

---

## 如何扩展

### 新增一个工具（3 步）

```ts
// 1. 在 src/agent/tools.ts 实现 ToolDefinition
const myTool: ToolDefinition = {
  name: 'my_tool',
  description: '写清「什么时候调用」，而不只是工具名 —— 这直接影响模型选择准确率',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: '查询内容' } },
    required: ['query'],
  },
  async run(args, ctx) {
    return { text: '返回给模型的文本结果' }
  },
}

// 2. 注册
export const TOOL_REGISTRY = [..., myTool]
```

3. 完成。运行时、UI、真实模型的 tools 声明会自动包含它。

### 换一个推理后端

只需重写 `src/agent/runtime.ts` 里的对应函数，保持 `AsyncGenerator<AgentEvent>` 契约不变，整个界面无需改动。

### 替换检索方案

改写 `src/agent/retrieval.ts` 的 `search()`，返回 `RetrievalHit[]` 即可，UI 会自动渲染新的相关度分数。

---

## 部署

### 静态部署（推荐，Mock 模式足够演示）

```bash
npm run build
```

产物在 `dist/`，可部署到 Vercel / Netlify / Cloudflare Pages / GitHub Pages。

```bash
npx vercel --prod
```

### 需要代理时

若模型服务未开放浏览器 CORS，在 Vercel 项目设置中添加环境变量：

```
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_API_KEY=sk-xxxxxxxx
LLM_MODEL=qwen-plus
```

`api/llm-proxy.ts` 会自动注册为 Edge Function。然后在前端设置里把 Base URL 改成 `/api/llm-proxy`。

---

## Roadmap

- [ ] 接入向量检索（embedding + 重排序）
- [ ] 导出单次运行链路为 JSON / 图片，便于贴进 issue
- [ ] 多轮对话模式（当前为单次任务执行）
- [ ] 提示词 A/B 对比：同一目标跑两套提示词，并排比对链路
- [ ] 评测集与自动化回归

---

## License

MIT
