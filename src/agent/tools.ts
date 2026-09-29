/**
 * 工具注册表（Tool Registry）
 *
 * 每个工具声明三件事：名称、给模型看的描述与参数 schema、以及真实执行函数。
 * 新增一个工具只需实现 ToolDefinition 并注册进 registry，
 * Agent 运行时与 UI 都不需要改动 —— 这是这个项目在架构上的核心卖点。
 */

import type { ChartSpec } from './types'
import type { RetrievalIndex } from './retrieval'
import { search } from './retrieval'

export interface ToolParamSchema {
  type: 'object'
  properties: Record<
    string,
    { type: 'string' | 'number' | 'boolean'; description: string; enum?: string[] }
  >
  required?: string[]
}

export interface ToolContext {
  index: RetrievalIndex
  /** 工具可以抛出结构化图表，由运行时转成事件 */
  emitChart: (spec: ChartSpec) => void
}

export interface ToolRunResult {
  /** 回灌给模型 / 展示给用户的文本结果 */
  text: string
  /** 供 UI 渲染的附加数据 */
  data?: Record<string, unknown>
}

export interface ToolDefinition {
  name: string
  /** 写清「什么时候用」，而不是只写工具名 —— 直接影响模型选择准确率 */
  description: string
  parameters: ToolParamSchema
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolRunResult>
}

/* ------------------------------------------------------------------ */
/* 安全表达式求值：递归下降解析，不使用 eval                            */
/* ------------------------------------------------------------------ */

function evaluateExpression(input: string): number {
  const tokens = input.match(/\d+(\.\d+)?|[+\-*/%^()]/g)
  if (!tokens || tokens.length === 0) throw new Error('表达式中没有可计算的数字')

  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]

  function parseExpression(): number {
    let left = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const op = next()
      const right = parseTerm()
      left = op === '+' ? left + right : left - right
    }
    return left
  }

  function parseTerm(): number {
    let left = parsePower()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next()
      const right = parsePower()
      if (op === '*') left *= right
      else if (op === '/') {
        if (right === 0) throw new Error('除数不能为 0')
        left /= right
      } else left %= right
    }
    return left
  }

  function parsePower(): number {
    const base = parseUnary()
    if (peek() === '^') {
      next()
      return Math.pow(base, parsePower())
    }
    return base
  }

  function parseUnary(): number {
    if (peek() === '-') {
      next()
      return -parseUnary()
    }
    if (peek() === '+') {
      next()
      return parseUnary()
    }
    return parsePrimary()
  }

  function parsePrimary(): number {
    const token = next()
    if (token === undefined) throw new Error('表达式不完整')
    if (token === '(') {
      const value = parseExpression()
      if (next() !== ')') throw new Error('括号不匹配')
      return value
    }
    if (/^\d/.test(token)) return Number(token)
    throw new Error(`无法识别的符号：${token}`)
  }

  const result = parseExpression()
  if (pos !== tokens.length) throw new Error('表达式存在多余内容')
  if (!Number.isFinite(result)) throw new Error('计算结果不是有效数字')
  return result
}

/* ------------------------------------------------------------------ */
/* 伪随机：保证同一输入总是得到同一结果，让 Mock 演示可复现             */
/* ------------------------------------------------------------------ */

function hashString(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededRandom(seed: number): () => number {
  let state = seed || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4294967296
  }
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

const knowledgeSearchTool: ToolDefinition = {
  name: 'knowledge_search',
  description:
    '在企业知识库中做语义检索，返回最相关的文档片段与相关度分数。当问题涉及公司制度、技术方案、操作规程、行业规则等需要依据的场景时使用，不要凭记忆回答这类问题。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索用的自然语言问题或关键词' },
      topK: { type: 'number', description: '返回的片段数量，默认 4' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const query = String(args.query ?? '')
    const topK = Number(args.topK ?? 4)
    const hits = search(ctx.index, query, topK)
    if (hits.length === 0) {
      return { text: `未检索到与「${query}」相关的内容。建议更换关键词或确认知识库是否已收录该主题。` }
    }
    const text = hits
      .map(
        (hit, i) =>
          `[${i + 1}] 《${hit.docTitle}》 相关度 ${(hit.score * 100).toFixed(0)}%\n${hit.snippet}`,
      )
      .join('\n\n')
    return { text, data: { hits } }
  },
}

const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description:
    '计算数学表达式，支持 + - * / % ^ 与括号。需要做数值计算、比率换算、成本收益测算时使用，不要自己心算。',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '例如 (1200-800)*0.8*365' },
    },
    required: ['expression'],
  },
  async run(args) {
    const expression = String(args.expression ?? '')
    try {
      const value = evaluateExpression(expression)
      return { text: `${expression} = ${Number(value.toFixed(6))}`, data: { value } }
    } catch (error) {
      return { text: `计算失败：${(error as Error).message}` }
    }
  },
}

const currentTimeTool: ToolDefinition = {
  name: 'current_time',
  description: '获取当前日期与时间。当问题涉及「今天」「本月」「最近」等相对时间时使用。',
  parameters: { type: 'object', properties: {} },
  async run() {
    const now = new Date()
    const text = now.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'long',
    })
    return { text: `当前时间：${text}`, data: { iso: now.toISOString() } }
  },
}

const energyForecastTool: ToolDefinition = {
  name: 'energy_forecast',
  description:
    '给定电站名称与预测天数，返回光伏出力预测曲线（含预测值与实际值）。当用户要求预测发电量、查看出力曲线、评估预测精度时使用。返回结果会自动渲染成图表。',
  parameters: {
    type: 'object',
    properties: {
      station: { type: 'string', description: '电站名称，例如「南沙园区光伏电站」' },
      days: { type: 'number', description: '预测天数，1 至 7，默认 1' },
      capacity: { type: 'number', description: '装机容量 MW，默认 20' },
    },
    required: ['station'],
  },
  async run(args, ctx) {
    const station = String(args.station ?? '示例电站')
    const days = Math.min(7, Math.max(1, Number(args.days ?? 1)))
    const capacity = Number(args.capacity ?? 20)
    const random = seededRandom(hashString(`${station}-${days}-${capacity}`))

    const pointsPerDay = 8 // 每 3 小时一个点，便于图表阅读
    const categories: string[] = []
    const forecast: number[] = []
    const actual: number[] = []

    for (let d = 0; d < days; d += 1) {
      for (let h = 0; h < pointsPerDay; h += 1) {
        const hour = (h * 24) / pointsPerDay
        categories.push(`D${d + 1} ${String(Math.floor(hour)).padStart(2, '0')}:00`)
        // 光伏出力呈钟形曲线，正午最高
        const bell = Math.exp(-Math.pow((hour - 12) / 4.2, 2))
        const cloud = 0.72 + random() * 0.26
        const base = capacity * bell * cloud
        forecast.push(Number(base.toFixed(2)))
        actual.push(Number(Math.max(0, base * (0.86 + random() * 0.26)).toFixed(2)))
      }
    }

    const totalForecast = forecast.reduce((sum, v) => sum + v * 3, 0)
    const totalActual = actual.reduce((sum, v) => sum + v * 3, 0)
    const mae =
      forecast.reduce((sum, v, i) => sum + Math.abs(v - actual[i]), 0) / forecast.length
    const nrmse = Math.sqrt(
      forecast.reduce((sum, v, i) => sum + Math.pow(v - actual[i], 2), 0) / forecast.length,
    )

    const spec: ChartSpec = {
      id: `chart-${Date.now()}`,
      title: `${station} 光伏出力预测（未来 ${days} 天）`,
      unit: 'MW',
      type: 'line',
      categories,
      series: [
        { name: '预测出力', data: forecast },
        { name: '实际出力', data: actual },
      ],
    }
    ctx.emitChart(spec)

    const text = [
      `电站：${station}（装机 ${capacity} MW）`,
      `预测区间：未来 ${days} 天，共 ${categories.length} 个采样点`,
      `预测发电量：${totalForecast.toFixed(1)} MWh，实际上网：${totalActual.toFixed(1)} MWh`,
      `平均绝对误差 MAE：${mae.toFixed(2)} MW，均方根误差 RMSE：${nrmse.toFixed(2)} MW`,
      `已生成出力曲线图。`,
    ].join('\n')

    return { text, data: { spec } }
  },
}

const peakValleyTool: ToolDefinition = {
  name: 'peak_valley_saving',
  description:
    '测算储能峰谷套利的收益。当用户询问「能省多少钱」「投资回收期」「峰谷套利收益」时使用。',
  parameters: {
    type: 'object',
    properties: {
      capacityMWh: { type: 'number', description: '储能容量 MWh' },
      priceGap: { type: 'number', description: '峰谷价差 元/kWh' },
      efficiency: { type: 'number', description: '综合充放电效率 0~1，默认 0.88' },
      cyclesPerYear: { type: 'number', description: '年循环次数，默认 330' },
    },
    required: ['capacityMWh', 'priceGap'],
  },
  async run(args, ctx) {
    const capacity = Number(args.capacityMWh ?? 1)
    const priceGap = Number(args.priceGap ?? 0.8)
    const efficiency = Number(args.efficiency ?? 0.88)
    const cycles = Number(args.cyclesPerYear ?? 330)

    const dailySaving = capacity * 1000 * priceGap * efficiency
    const annualSaving = dailySaving * cycles

    const spec: ChartSpec = {
      id: `chart-${Date.now()}`,
      title: `储能峰谷套利收益测算（${capacity} MWh / 价差 ${priceGap} 元）`,
      unit: '万元',
      type: 'bar',
      categories: ['1 年', '3 年', '5 年', '8 年', '10 年'],
      series: [
        {
          name: '累计收益',
          data: [1, 3, 5, 8, 10].map((y) => Number(((annualSaving * y) / 10000).toFixed(2))),
        },
      ],
    }
    ctx.emitChart(spec)

    const text = [
      `测算条件：容量 ${capacity} MWh，峰谷价差 ${priceGap} 元/kWh，效率 ${efficiency}，年循环 ${cycles} 次`,
      `单日套利收益：${dailySaving.toFixed(0)} 元`,
      `年收益：${(annualSaving / 10000).toFixed(2)} 万元`,
      `5 年累计收益：${((annualSaving * 5) / 10000).toFixed(2)} 万元`,
      `已生成收益趋势图。`,
    ].join('\n')

    return { text, data: { spec } }
  },
}

export const TOOL_REGISTRY: ToolDefinition[] = [
  knowledgeSearchTool,
  energyForecastTool,
  peakValleyTool,
  calculatorTool,
  currentTimeTool,
]

export function getTool(name: string): ToolDefinition | undefined {
  return TOOL_REGISTRY.find((tool) => tool.name === name)
}

/** 导出给真实 LLM 使用的 OpenAI 兼容 tools 字段 */
export function toOpenAITools() {
  return TOOL_REGISTRY.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}
