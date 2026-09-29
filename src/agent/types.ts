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

/** RAG 检索命中的一条切片 */
export interface RetrievalHit {
  chunkId: string
  docId: string
  docTitle: string
  snippet: string
  /** BM25 归一化后的相关度，0~1 */
  score: number
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
  | { type: 'plan'; nodes: PlanNode[] }
  | { type: 'node_status'; nodeId: string; status: NodeStatus; at: number }
  | { type: 'message_start'; messageId: string; role: MessageRole; kind?: 'think' | 'answer' }
  | { type: 'message_delta'; messageId: string; delta: string }
  | { type: 'message_end'; messageId: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; callId: string; result: string; endedAt: number }
  | { type: 'tool_error'; callId: string; error: string; endedAt: number }
  | { type: 'retrieval'; query: string; hits: RetrievalHit[] }
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

export const DEFAULT_SETTINGS: AppSettings = {
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
