/**
 * Agent 运行时
 *
 * runAgent 是一个 AsyncGenerator<AgentEvent>。
 * 所有的规划、思考、工具调用、检索、流式输出都以事件形式向外抛出，
 * UI 只负责把事件渲染出来，不参与任何推理逻辑。
 *
 * 这个设计带来三个直接收益：
 *   1. 事件流可直接录制 → 支持回放
 *   2. Mock 与真实模型走完全相同的出口 → UI 零改动切换
 *   3. 中断（AbortSignal）在任意 await 点都能干净退出
 */

import type {
  AgentEvent,
  AppSettings,
  ChartSpec,
  HybridSearchOutcome,
  PlanNode,
  RetrievalHit,
  RetrievalTrace,
  ToolCall,
} from './types'
import { TOOL_REGISTRY, getTool, toOpenAITools } from './tools'
import {
  buildIndex,
  chunkDocuments,
  DEFAULT_CHUNK_OPTIONS,
  hashText,
  rrfFusion,
  searchBM25,
  searchVector,
} from './retrieval'
import type { Chunk, RetrievalIndex, VectorIndex } from './retrieval'
import { EmbedUnavailableError, embedTexts, ensureVectorIndex } from './embedding'
import { BUILTIN_CORPUS } from './corpus'
import type { KnowledgeDoc } from './corpus'
import { buildMockPlan, planWithLLM } from './planner'
import type { MockToolResult } from './planner'
import { chatTurn, checkServerManaged, hasApiKey, streamChat } from './llm'
import type { LLMMessage } from './llm'

/** 语义通道的默认接入点 */
export const DEFAULT_EMBED_ENDPOINT = '/api/embed'

export interface RuntimeContext {
  settings: AppSettings
  docs: KnowledgeDoc[]
  signal?: AbortSignal
  /** 覆盖语义通道地址，主要用于测试 */
  embeddingEndpoint?: string
}

let idCounter = 0
function uid(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new DOMException('运行已取消', 'AbortError'))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 把长文本切成小片逐个吐出，模拟 token 流 */
async function* streamText(
  text: string,
  speed: number,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const size = 3
  for (let i = 0; i < text.length; i += size) {
    if (signal?.aborted) throw new DOMException('运行已取消', 'AbortError')
    yield text.slice(i, i + size)
    await sleep(Math.max(5, 22 / speed), signal)
  }
}

function estimateTokens(text: string): number {
  // 中文约占 1 token/字，英文约 0.25 token/字符，这里取折中估计
  return Math.max(1, Math.round(text.length * 0.8))
}

export function buildRuntimeIndex(docs: KnowledgeDoc[]): {
  index: RetrievalIndex
  chunkCount: number
} {
  const chunks: Chunk[] = chunkDocuments(docs, DEFAULT_CHUNK_OPTIONS)
  return { index: buildIndex(chunks), chunkCount: chunks.length }
}

/* ------------------------------------------------------------------ */
/* 检索器：把「词汇 + 语义 + 融合」组装成一个可注入的能力               */
/* ------------------------------------------------------------------ */

export interface Retriever {
  index: RetrievalIndex
  /** 语义通道的向量集合；为 null 表示本次只能用词汇通道 */
  vector: VectorIndex | null
  /** 语义通道的状态说明（不可用或部分覆盖时给出原因） */
  vectorNote?: string
  search: (query: string, topK: number) => Promise<HybridSearchOutcome>
}

function docsFingerprint(docs: KnowledgeDoc[]): string {
  return hashText(docs.map((d) => `${d.id}\u0000${d.title}\u0000${d.content}`).join('\u0001'))
}

/**
 * 检索器准备一次后缓存复用。
 *
 * 为什么要缓存？因为准备过程包含一次网络往返（拉取或编码向量），
 * 而语料在一次会话里通常是稳定的。每次点「运行」都重来一遍，
 * 既慢又白烧额度，还会让首屏多等一轮。
 * 缓存键取「语料指纹 + 接入地址」：语料一变自动失效，不需要手动清理。
 */
let retrieverCache: { key: string; promise: Promise<Retriever> } | null = null

export function prepareRetriever(ctx: RuntimeContext): Promise<Retriever> {
  const endpoint = ctx.embeddingEndpoint ?? DEFAULT_EMBED_ENDPOINT
  const key = `${docsFingerprint(ctx.docs)}::${endpoint}`
  if (retrieverCache?.key === key) return retrieverCache.promise

  const promise = buildRetriever(ctx.docs, endpoint)
  retrieverCache = { key, promise }
  return promise
}

/** 清空检索器缓存。语料被替换或测试时使用。 */
export function invalidateRetriever(): void {
  retrieverCache = null
}

async function buildRetriever(docs: KnowledgeDoc[], endpoint: string): Promise<Retriever> {
  const chunks = chunkDocuments(docs, DEFAULT_CHUNK_OPTIONS)
  const index = buildIndex(chunks)

  // 这里刻意不传运行时的 AbortSignal：检索器是跨运行共享的，
  // 若被某次取消连带中断，缓存里就会留下一个永久 reject 的 promise，
  // 之后所有运行都会莫名其妙地拿不到语义通道。
  const { index: vector, note } = await ensureVectorIndex(chunks, { endpoint })

  const search = async (query: string, topK: number): Promise<HybridSearchOutcome> => {
    const bm25 = searchBM25(index, query, topK)

    // 没有向量就退回纯词汇检索。这不是异常路径而是设计内的降级，
    // 但必须把原因带出去让界面说清楚，否则会被误判成「就这水平」。
    if (!vector) {
      const trace: RetrievalTrace = {
        query,
        bm25,
        vector: null,
        fused: bm25,
        vectorStatus: 'unavailable',
        note,
        fusion: 'bm25-only',
      }
      return { hits: bm25, trace }
    }

    const startedAt = Date.now()
    try {
      const [queryVector] = await embedTexts([query], { endpoint })
      if (!queryVector || queryVector.length === 0) {
        throw new Error('查询语句未能编码为向量')
      }
      const vectorHits = searchVector(index, vector, queryVector, topK)
      const fused = rrfFusion(bm25, vectorHits, topK)
      return {
        hits: fused,
        trace: {
          query,
          bm25,
          vector: vectorHits,
          fused,
          vectorStatus: 'ok',
          note,
          vectorLatencyMs: Date.now() - startedAt,
          fusion: 'rrf',
        },
      }
    } catch (error) {
      const reason =
        error instanceof EmbedUnavailableError ? error.message : (error as Error).message
      // 单次失败只影响这一次检索，不该让整个运行挂掉 —— 词汇通道仍然可用
      return {
        hits: bm25,
        trace: {
          query,
          bm25,
          vector: null,
          fused: bm25,
          vectorStatus: 'failed',
          note: `语义通道调用失败（${reason}），本次退化为纯 BM25 词汇检索。`,
          vectorLatencyMs: Date.now() - startedAt,
          fusion: 'bm25-only',
        },
      }
    }
  }

  return { index, vector, vectorNote: note, search }
}

/** 把检索器状态转成运行日志，让「这一轮到底用了哪些通道」一目了然 */
function retrieverLogs(retriever: Retriever): AgentEvent[] {
  const events: AgentEvent[] = [
    {
      type: 'log',
      level: 'info',
      text: `已加载知识库，共 ${retriever.index.chunks.length} 个切片`,
    },
  ]

  if (retriever.vector) {
    events.push({
      type: 'log',
      level: 'info',
      text: `语义通道就绪：${retriever.vector.model}（${retriever.vector.dim} 维）覆盖 ${retriever.vector.covered}/${retriever.vector.total} 个切片，检索采用 BM25 + 向量 + RRF 融合`,
    })
    if (retriever.vectorNote) {
      events.push({ type: 'log', level: 'warn', text: retriever.vectorNote })
    }
  } else {
    events.push({
      type: 'log',
      level: 'warn',
      text: retriever.vectorNote ?? '语义通道不可用，本次检索退化为纯 BM25 词汇检索',
    })
  }

  return events
}

/** 从工具返回的附加数据里取出检索结果与过程记录 */
function readRetrieval(resultData: Record<string, unknown> | undefined): {
  hits?: RetrievalHit[]
  trace?: RetrievalTrace
} {
  if (!resultData) return {}
  return {
    hits: resultData.hits as RetrievalHit[] | undefined,
    trace: resultData.trace as RetrievalTrace | undefined,
  }
}

/**
 * 是否值得为这次工具结果发一条检索事件。
 * 注意「检索了但没命中」也要发 —— 空结果比有结果更需要被看见，
 * 否则用户无法区分「压根没检索」和「检索了没找到」，而这是两个完全不同的问题。
 */
function shouldEmitRetrieval(hits?: RetrievalHit[], trace?: RetrievalTrace): boolean {
  return Boolean(trace) || Boolean(hits && hits.length > 0)
}

const SYSTEM_PROMPT = `你是 AgentLens 内置的智能体，负责回答新能源运营领域的问题。

工作要求：
1. 凡是涉及公司制度、技术方案、操作规程、行业规则的问题，必须先调用 knowledge_search 检索知识库，禁止凭记忆作答。检索采用「词汇 + 语义」混合策略，可以直接用自然语言提问，不必刻意堆砌关键词。
2. 涉及数值计算时调用 calculator，不要心算。
3. 涉及发电预测、出力曲线的请求调用 energy_forecast。
4. 涉及收益测算、投资回报的请求调用 peak_valley_saving。
5. 回答要结构清晰，引用知识库内容时标注文档标题。
6. 检索不到依据时，明确说明「未检索到相关依据」，不要编造。`

/**
 * Mock 模式：完全离线、结果确定、可复现。
 * 注意它调用的是真实的工具实现，所以检索分数与计算结果都是真实数据，
 * 只有「模型措辞」是模板化的。
 */
export async function* runMockAgent(
  goal: string,
  ctx: RuntimeContext,
): AsyncGenerator<AgentEvent> {
  const runId = uid('run')
  const startedAt = Date.now()
  const speed = ctx.settings.speed

  yield { type: 'run_start', runId, goal, mode: 'mock', startedAt }
  yield { type: 'log', level: 'info', text: '正在准备知识库索引…' }

  const retriever = await prepareRetriever(ctx)
  for (const event of retrieverLogs(retriever)) yield event

  await sleep(260 / speed, ctx.signal)
  yield { type: 'log', level: 'info', text: '正在拆解任务…' }

  const plan = buildMockPlan(goal)
  const nodes: PlanNode[] = JSON.parse(JSON.stringify(plan.nodes)) as PlanNode[]

  await sleep(420 / speed, ctx.signal)
  yield { type: 'plan', nodes }
  yield { type: 'log', level: 'info', text: `规划完成，共 ${nodes.length} 个步骤（意图：${plan.intent}）` }

  const collected: MockToolResult[] = []
  let promptTokens = estimateTokens(goal) + 320
  let completionTokens = 0

  for (const step of plan.steps) {
    const nodeIndex = nodes.findIndex((n) => n.id === step.nodeId)
    if (nodeIndex >= 0 && nodes[nodeIndex].status === 'pending') {
      nodes[nodeIndex].status = 'running'
      yield { type: 'node_status', nodeId: step.nodeId, status: 'running', at: Date.now() }
    }

    if (step.kind === 'think') {
      const messageId = uid('think')
      yield { type: 'message_start', messageId, role: 'assistant', kind: 'think' }
      for await (const delta of streamText(step.text, speed, ctx.signal)) {
        yield { type: 'message_delta', messageId, delta }
        completionTokens += estimateTokens(delta)
      }
      yield { type: 'message_end', messageId }
    }

    if (step.kind === 'tool') {
      const call: ToolCall = {
        id: uid('call'),
        name: step.name,
        args: step.args,
        status: 'running',
        startedAt: Date.now(),
        nodeId: step.nodeId,
      }
      yield { type: 'tool_call', call }
      yield {
        type: 'log',
        level: 'info',
        text: `调用工具 ${step.name}(${JSON.stringify(step.args)})`,
      }

      promptTokens += estimateTokens(JSON.stringify(step.args)) + 60
      const tool = getTool(step.name)
      const charts: ChartSpec[] = []
      let resultText = ''
      let resultData: Record<string, unknown> | undefined

      if (!tool) {
        resultText = `工具 ${step.name} 未注册`
        yield { type: 'tool_error', callId: call.id, error: resultText, endedAt: Date.now() }
      } else {
        try {
          await sleep(Math.max(120, 520 / speed), ctx.signal)
          const result = await tool.run(step.args, {
            index: retriever.index,
            emitChart: (spec) => charts.push(spec),
            hybridSearch: retriever.search,
          })
          resultText = result.text
          resultData = result.data
          yield { type: 'tool_result', callId: call.id, result: resultText, endedAt: Date.now() }
        } catch (error) {
          resultText = `工具执行异常：${(error as Error).message}`
          yield { type: 'tool_error', callId: call.id, error: resultText, endedAt: Date.now() }
        }
      }

      completionTokens += estimateTokens(resultText)

      const { hits, trace } = readRetrieval(resultData)
      if (shouldEmitRetrieval(hits, trace)) {
        yield { type: 'retrieval', query: String(step.args.query ?? ''), hits: hits ?? [], trace }
      }
      for (const spec of charts) {
        yield { type: 'chart', spec }
      }

      collected.push({ name: step.name, text: resultText, data: resultData })
    }

    if (step.kind === 'answer') {
      const messageId = uid('msg')
      yield { type: 'message_start', messageId, role: 'assistant', kind: 'answer' }
      const answer = step.compose({ goal, results: collected })
      for await (const delta of streamText(answer, speed, ctx.signal)) {
        yield { type: 'message_delta', messageId, delta }
        completionTokens += estimateTokens(delta)
      }
      yield { type: 'message_end', messageId }
    }

    if (nodeIndex >= 0) {
      nodes[nodeIndex].status = 'done'
      nodes[nodeIndex].endedAt = Date.now()
      yield { type: 'node_status', nodeId: step.nodeId, status: 'done', at: Date.now() }
    }

    await sleep(Math.max(60, 180 / speed), ctx.signal)
  }

  yield { type: 'usage', usage: { promptTokens, completionTokens } }
  yield { type: 'run_end', status: 'done', endedAt: Date.now() }
}

/** 真实模型模式：规划 → Function Calling 循环 → 流式输出最终答案 */
export async function* runLiveAgent(
  goal: string,
  ctx: RuntimeContext,
): AsyncGenerator<AgentEvent> {
  const runId = uid('run')
  const startedAt = Date.now()

  yield { type: 'run_start', runId, goal, mode: 'live', startedAt }
  yield { type: 'log', level: 'info', text: '正在准备知识库索引…' }

  const retriever = await prepareRetriever(ctx)
  for (const event of retrieverLogs(retriever)) yield event

  yield { type: 'log', level: 'info', text: `模型：${ctx.settings.llm.model}` }

  let promptTokens = 0
  let completionTokens = 0
  let nodes: PlanNode[] = []

  try {
    yield { type: 'log', level: 'info', text: '正在调用模型进行任务拆解…' }
    nodes = await planWithLLM(ctx.settings.llm, goal, ctx.signal)
    promptTokens += estimateTokens(goal) + 260
    completionTokens += estimateTokens(JSON.stringify(nodes))
    yield { type: 'plan', nodes }
    yield { type: 'log', level: 'info', text: `规划完成，共 ${nodes.length} 个步骤` }

    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: goal },
    ]
    const tools = toOpenAITools()

    const maxRounds = 6
    for (let round = 0; round < maxRounds; round += 1) {
      if (ctx.signal?.aborted) throw new DOMException('运行已取消', 'AbortError')

      const turn = await chatTurn(ctx.settings.llm, messages, tools, ctx.signal)
      if (turn.usage) {
        promptTokens += turn.usage.promptTokens
        completionTokens += turn.usage.completionTokens
      }

      if (turn.toolCalls.length === 0) break

      messages.push({
        role: 'assistant',
        // 带 tool_calls 的 assistant 消息，content 必须为 null。
        // 传空字符串在 OpenAI 官方实现上能跑通，但智谱等严格实现会直接返回 400。
        content: turn.content.trim() ? turn.content : null,
        tool_calls: turn.toolCalls,
      })

      for (const toolCall of turn.toolCalls) {
        const toolName = toolCall.function.name
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>
        } catch {
          args = {}
        }

        // 顺序推进：优先认领「规划中第一个绑定同名工具的节点」，否则取第一个待执行节点
        const activeNode =
          nodes.find((n) => n.status === 'running') ??
          nodes.find((n) => n.status === 'pending' && n.tool === toolName) ??
          nodes.find((n) => n.status === 'pending')
        if (activeNode) {
          activeNode.status = 'running'
          yield { type: 'node_status', nodeId: activeNode.id, status: 'running', at: Date.now() }
        }

        const call: ToolCall = {
          id: toolCall.id || uid('call'),
          name: toolName,
          args,
          status: 'running',
          startedAt: Date.now(),
          nodeId: activeNode?.id,
        }
        yield { type: 'tool_call', call }

        const tool = getTool(toolName)
        const charts: ChartSpec[] = []
        let resultText: string

        if (!tool) {
          resultText = `工具 ${toolName} 未注册`
          yield { type: 'tool_error', callId: call.id, error: resultText, endedAt: Date.now() }
        } else {
          try {
            const result = await tool.run(args, {
              index: retriever.index,
              emitChart: (spec) => charts.push(spec),
              hybridSearch: retriever.search,
            })
            resultText = result.text
            yield { type: 'tool_result', callId: call.id, result: resultText, endedAt: Date.now() }

            const { hits, trace } = readRetrieval(result.data)
            if (shouldEmitRetrieval(hits, trace)) {
              yield { type: 'retrieval', query: String(args.query ?? ''), hits: hits ?? [], trace }
            }
            for (const spec of charts) yield { type: 'chart', spec }
          } catch (error) {
            resultText = `工具执行异常：${(error as Error).message}`
            yield { type: 'tool_error', callId: call.id, error: resultText, endedAt: Date.now() }
          }
        }

        messages.push({ role: 'tool', content: resultText, tool_call_id: call.id })
        if (activeNode) {
          activeNode.status = 'done'
          activeNode.endedAt = Date.now()
          yield { type: 'node_status', nodeId: activeNode.id, status: 'done', at: Date.now() }
        }
      }
    }

    yield { type: 'log', level: 'info', text: '正在生成最终回答…' }
    const messageId = uid('msg')
    yield { type: 'message_start', messageId, role: 'assistant', kind: 'answer' }
    for await (const delta of streamChat(ctx.settings.llm, messages, ctx.signal)) {
      yield { type: 'message_delta', messageId, delta }
      completionTokens += estimateTokens(delta)
    }
    yield { type: 'message_end', messageId }

    for (const n of nodes) {
      if (n.status === 'running' || n.status === 'pending') {
        n.status = 'done'
        n.endedAt = Date.now()
        yield { type: 'node_status', nodeId: n.id, status: 'done', at: Date.now() }
      }
    }

    yield { type: 'usage', usage: { promptTokens, completionTokens } }
    yield { type: 'run_end', status: 'done', endedAt: Date.now() }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      for (const n of nodes) {
        if (n.status === 'running') {
          n.status = 'skipped'
          yield { type: 'node_status', nodeId: n.id, status: 'skipped', at: Date.now() }
        }
      }
      yield { type: 'run_end', status: 'cancelled', endedAt: Date.now() }
      return
    }
    yield { type: 'error', message: (error as Error).message }
    yield { type: 'run_end', status: 'error', endedAt: Date.now() }
  }
}

/**
 * 以 Mock 跑完，并在开头显式声明发生了回退。
 *
 * 回退事件必须排在 run_start 之后发：run_start 会重置状态，
 * 若先发回退事件会被一起清掉，用户看到的就还是「切了模式但结果没变」。
 */
async function* runMockWithFallback(
  goal: string,
  ctx: RuntimeContext,
  reason: string,
): AsyncGenerator<AgentEvent> {
  let emitted = false
  for await (const event of runMockAgent(goal, ctx)) {
    yield event
    if (!emitted) {
      emitted = true
      yield {
        type: 'mode_fallback',
        requested: 'live',
        actual: 'mock',
        reason: `${reason}，本次实际以 Mock 模式运行`,
      }
      yield {
        type: 'log',
        level: 'warn',
        text: `${reason}，已自动回退到 Mock 模式。可在右上角「设置」中调整。`,
      }
    }
  }
}

export async function* runAgent(
  goal: string,
  ctx: RuntimeContext,
): AsyncGenerator<AgentEvent> {
  if (ctx.settings.mode === 'live') {
    if (!hasApiKey(ctx.settings.llm)) {
      yield* runMockWithFallback(goal, ctx, '未配置 API Key')
      return
    }

    // 服务端托管模式下先确认服务端到底配没配密钥。
    // 不探这一次的话，服务端漏配密钥时访客会直接撞上一个「模型请求失败」的错误页 ——
    // 对第一次打开链接的人来说，那等于「这东西是坏的」。
    // 先探一次就能干净地降级到 Mock，把一次失败变成一次可解释的降级。
    const status = await checkServerManaged(ctx.settings.llm)
    if (status.configured) {
      yield* runLiveAgent(goal, ctx)
      return
    }

    yield* runMockWithFallback(goal, ctx, status.reason ?? '服务端未配置模型密钥')
    return
  }

  yield* runMockAgent(goal, ctx)
}

export const AVAILABLE_TOOLS = TOOL_REGISTRY
export { BUILTIN_CORPUS }
