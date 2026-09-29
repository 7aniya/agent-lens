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

import type { AgentEvent, AppSettings, ChartSpec, PlanNode, ToolCall } from './types'
import { TOOL_REGISTRY, getTool, toOpenAITools } from './tools'
import { buildIndex, chunkDocuments, DEFAULT_CHUNK_OPTIONS } from './retrieval'
import type { RetrievalIndex, Chunk } from './retrieval'
import { BUILTIN_CORPUS } from './corpus'
import type { KnowledgeDoc } from './corpus'
import { buildMockPlan, planWithLLM } from './planner'
import type { MockToolResult } from './planner'
import { chatTurn, streamChat } from './llm'
import type { LLMMessage } from './llm'

export interface RuntimeContext {
  settings: AppSettings
  docs: KnowledgeDoc[]
  signal?: AbortSignal
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

const SYSTEM_PROMPT = `你是 AgentLens 内置的智能体，负责回答新能源运营领域的问题。

工作要求：
1. 凡是涉及公司制度、技术方案、操作规程、行业规则的问题，必须先调用 knowledge_search 检索知识库，禁止凭记忆作答。
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
  const { index } = buildRuntimeIndex(ctx.docs)

  yield { type: 'run_start', runId, goal, mode: 'mock', startedAt }
  yield { type: 'log', level: 'info', text: `已加载知识库，共 ${index.chunks.length} 个切片` }

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
            index,
            emitChart: (spec) => charts.push(spec),
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

      const hits = resultData?.hits as
        | { chunkId: string; docId: string; docTitle: string; snippet: string; score: number }[]
        | undefined
      if (hits && hits.length > 0) {
        yield {
          type: 'retrieval',
          query: String(step.args.query ?? ''),
          hits,
        }
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
  const { index } = buildRuntimeIndex(ctx.docs)

  yield { type: 'run_start', runId, goal, mode: 'live', startedAt }
  yield { type: 'log', level: 'info', text: `已加载知识库，共 ${index.chunks.length} 个切片` }
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
        content: turn.content,
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
              index,
              emitChart: (spec) => charts.push(spec),
            })
            resultText = result.text
            yield { type: 'tool_result', callId: call.id, result: resultText, endedAt: Date.now() }

            const hits = result.data?.hits as
              | {
                  chunkId: string
                  docId: string
                  docTitle: string
                  snippet: string
                  score: number
                }[]
              | undefined
            if (hits && hits.length > 0) {
              yield { type: 'retrieval', query: String(args.query ?? ''), hits }
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

export async function* runAgent(
  goal: string,
  ctx: RuntimeContext,
): AsyncGenerator<AgentEvent> {
  if (ctx.settings.mode === 'live' && ctx.settings.llm.apiKey.trim()) {
    yield* runLiveAgent(goal, ctx)
    return
  }
  if (ctx.settings.mode === 'live') {
    yield {
      type: 'log',
      level: 'warn',
      text: '未配置 API Key，已自动回退到 Mock 模式。可在右上角「设置」中填写。',
    }
  }
  yield* runMockAgent(goal, ctx)
}

export const AVAILABLE_TOOLS = TOOL_REGISTRY
export { BUILTIN_CORPUS }
