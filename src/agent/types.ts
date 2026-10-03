/**
 * AgentLens 核心类型定义
 *
 * 设计说明：
 * Agent 运行时是一个「异步事件流」（AsyncGenerator<AgentEvent>）。
 * UI 层只消费事件，不关心事件是来自 Mock 推理还是真实 LLM 调用。
 * 这带来两个好处：
 *   1. 离线可演示（Mock 模式不需要任何 API Key）
 *   2. 事件流天然可录制、可回放、可持久化成 trace 文件
 */

export type NodeStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'

/** 规划阶段拆解出的一个子任务节点 */
export interface PlanNode {
  id: string
  title: string
  detail?: string
  status: NodeStatus
  /** 该节点绑定的工具名（若有） */
  tool?: string
  startedAt?: number
  endedAt?: number
}

export type ToolCallStatus = 'running' | 'done' | 'error'

/** 一次工具调用的完整记录 */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  status: ToolCallStatus
  /** 工具返回的纯文本结果（用于展示） */
  result?: string
  error?: string
  startedAt: number
  endedAt?: number
  /** 该工具调用归属的规划节点 */
  nodeId?: string
}

/**
 * 检索通道。
 * 混合检索的价值恰恰在于「两个通道各自召回什么」是可见的，
 * 所以命中结果必须带上是哪个通道命中的，而不是融合完只留一个分数。
 */
export type RetrievalChannel = 'bm25' | 'vector'

/** RAG 检索命中的一条切片 */
export interface RetrievalHit {
  chunkId: string
  docId: string
  docTitle: string
  snippet: string
  /** 最终用于排序与展示的分数，0~1 */
  score: number
  /** 词汇通道 BM25 归一化分数，未被该通道命中时为 undefined */
  bm25Score?: number
  /** 语义通道余弦相似度归一化分数，未被该通道命中时为 undefined */
  vectorScore?: number
  /** RRF 融合分数（未归一化，仅用于排序解释） */
  rrfScore?: number
  /**
   * 命中该切片的通道列表。
   * 两个通道都命中 → 说明词汇信号与语义信号一致，这种结果可信度最高，
   * 界面上值得单独标出来，这是排查检索质量时最有用的一个信号。
   */
  channels: RetrievalChannel[]
}

/**
 * 一次检索的完整过程记录。
 *
 * 为什么要把两个通道的原始结果都留下来？
 * 只存融合后的 topK，就无法回答「这次答错到底是哪个通道拖后腿」——
 * 而这是调 RAG 时最高频的问题。所以过程的每一步都要留证。
 */
export interface RetrievalTrace {
  query: string
  /** 词汇通道的 topK，始终存在（纯本地计算，不会失败） */
  bm25: RetrievalHit[]
  /** 语义通道的 topK；向量不可用时为 null */
  vector: RetrievalHit[] | null
  /** RRF 融合后的最终结果 */
  fused: RetrievalHit[]
  vectorStatus: 'ok' | 'unavailable' | 'failed'
  /** 语义通道缺席时说明原因。检索降级必须显性，否则会被误判成「效果就这样」 */
  note?: string
  /** 语义通道额外耗时（含网络往返），用于衡量它到底值不值 */
  vectorLatencyMs?: number
  /** 融合策略标识，便于复现 */
  fusion: 'rrf' | 'bm25-only'
}

/** 一次混合检索的产出：给模型用的命中 + 给人看的过程 */
export interface HybridSearchOutcome {
  hits: RetrievalHit[]
  trace?: RetrievalTrace
}

export type MessageRole = 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  createdAt: number
  /** assistant 消息是否仍在流式输出中 */
  streaming?: boolean
  /** think = 推理过程，answer = 最终回答。UI 上两者样式不同 */
  kind?: 'think' | 'answer'
  /** 关联的工具调用（tool 角色消息） */
  toolCallId?: string
}

/** 可绘图的结构化数据，由工具返回，UI 自动渲染成图表 */
export interface ChartSpec {
  id: string
  title: string
  unit?: string
  type: 'bar' | 'line'
  categories: string[]
  series: { name: string; data: number[] }[]
}

export interface RunUsage {
  promptTokens: number
  completionTokens: number
}

/**
 * Agent 运行时向外抛出的事件。
 * 这是 UI 与推理内核之间唯一的契约。
 */
export type AgentEvent =
  | { type: 'run_start'; runId: string; goal: string; mode: RunMode; startedAt: number }
  /**
   * 运行模式回退。设置里选了「真实模型」但缺少 API Key 时触发，
   * 用于让界面显式告知用户「本次实际按 Mock 跑的」。
   * 这是独立事件而不是普通日志：回退会改变本次运行的性质，
   * 只写进日志会被忽略，用户看到的就是「切了模式但结果没变」。
   */
  | { type: 'mode_fallback'; requested: RunMode; actual: RunMode; reason: string }
  | { type: 'plan'; nodes: PlanNode[] }
  | { type: 'node_status'; nodeId: string; status: NodeStatus; at: number }
  | { type: 'message_start'; messageId: string; role: MessageRole; kind?: 'think' | 'answer' }
  | { type: 'message_delta'; messageId: string; delta: string }
  | { type: 'message_end'; messageId: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; callId: string; result: string; endedAt: number }
  | { type: 'tool_error'; callId: string; error: string; endedAt: number }
  /** hits 为融合后的最终结果；trace 保留两个通道的过程，供对照分析 */
  | { type: 'retrieval'; query: string; hits: RetrievalHit[]; trace?: RetrievalTrace }
  | { type: 'chart'; spec: ChartSpec }
  | { type: 'usage'; usage: RunUsage }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'run_end'; status: 'done' | 'error' | 'cancelled'; endedAt: number }
  | { type: 'error'; message: string }

export type RunMode = 'mock' | 'live'

/** 一条完整运行记录，可序列化保存用于回放 */
export interface RunRecord {
  id: string
  goal: string
  mode: RunMode
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'error' | 'cancelled'
  events: AgentEvent[]
}

export interface LLMConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 采样温度 */
  temperature: number
}

export interface AppSettings {
  mode: RunMode
  /** 运行速度倍率，1 = 正常，用于演示时加速 */
  speed: number
  llm: LLMConfig
}

/**
 * 服务端托管模式的哨兵值。
 *
 * 部署版把百炼 Key 放在 Vercel 环境变量里，前端不需要也不应该持有它。
 * 所以「Key 字段 = 这个哨兵」表示「这次请求走服务端代理」。
 * 必须与「空 Key」区分开：空 Key 会触发回退到 Mock，
 * 而哨兵代表真实模型可用的、且由服务端出密钥的一次调用。
 */
export const SERVER_MANAGED_KEY = '__server__'

/**
 * 当前是否具备使用服务端代理的条件。
 *
 * 本地 `npm run dev` 只起 vite，不带 api/ 下的函数路由，
 * 所以默认只能跑 Mock；而部署环境（Vercel）默认就该是「打开即对话」。
 * 用 hostname 判断而不是构建期变量：这样同一个构建产物在两种环境下
 * 都能给出最合适的默认值，也不必为本地和线上维护两套配置。
 */
function canUseServerProxy(): boolean {
  if (typeof window === 'undefined') return false
  const host = window.location.hostname
  return !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.local)$/.test(host)
}

/** 本地开发用的默认配置：直连智谱，需要自己填 Key */
const LOCAL_DEFAULTS: AppSettings = {
  mode: 'mock',
  speed: 1,
  llm: {
    // 默认指向智谱 GLM-4.7-Flash：目前少见的「永久免费」且支持工具调用的接口，
    // 用户注册后拿到 Key 填进设置即可切到真实模型，无需任何付费。
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4.7-flash',
    temperature: 0.3,
  },
}

/** 部署环境用的默认配置：走服务端代理，访客无需填写任何密钥 */
const DEPLOYED_DEFAULTS: AppSettings = {
  mode: 'live',
  speed: 1,
  llm: {
    baseUrl: '/api/llm-proxy',
    apiKey: SERVER_MANAGED_KEY,
    model: 'qwen-plus',
    temperature: 0.3,
  },
}

export const DEFAULT_SETTINGS: AppSettings = canUseServerProxy()
  ? DEPLOYED_DEFAULTS
  : LOCAL_DEFAULTS
