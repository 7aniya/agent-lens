/**
 * LLM 适配层
 *
 * 只依赖 OpenAI 兼容协议（/chat/completions），因此可以对接：
 * 阿里百炼兼容模式、DeepSeek、Moonshot、智谱、Ollama、vLLM 等。
 * 换成其他协议只需要改这一个文件。
 *
 * 设计要点：
 *  1. 所有失败都转成 LLMError，message 是「可直接展示给用户的多行中文说明」，
 *     包含状态码、请求地址、模型名、服务端原文与针对性排查建议。
 *     浏览器里 fetch 失败只会抛 `TypeError: Failed to fetch`，没有任何信息量，
 *     必须在这一层翻译成用户能看懂、能行动的话。
 *  2. 严格遵循 OpenAI 协议的发包细节（例如带 tool_calls 的 assistant 消息，
 *     content 必须是 null 而不是空字符串），否则在智谱等严格实现上会被 400 拒绝。
 */

import type { LLMConfig } from './types'

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /**
   * 带 tool_calls 的 assistant 消息必须为 null。
   * 传空字符串在宽松实现上无害，但智谱等服务会直接返回 400。
   */
  content: string | null
  tool_call_id?: string
  tool_calls?: LLMToolCall[]
}

export interface LLMToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type LLMErrorKind = 'network' | 'http' | 'parse'

/** 按 HTTP 状态码给出的排查方向 */
const STATUS_ADVICE: Record<number, string[]> = {
  400: [
    '模型名可能不存在或未开通——到服务商控制台核对模型列表里的准确名称',
    'Base URL 路径可能不对，注意有的服务是 /v1，智谱是 /api/paas/v4',
  ],
  401: [
    'API Key 复制不完整、含多余空格，或已被撤销——建议重新生成一个',
    'Key 与 Base URL 必须来自同一个平台，不能混用',
  ],
  403: ['账号未完成实名认证或未开通该模型', '调用来源被限制（IP / 地区 / 应用白名单）'],
  404: ['Base URL 地址写错，或缺少 /v1 这类路径段', '模型名不在该服务的模型列表中'],
  429: [
    '额度用尽或触发限流，稍等片刻再试',
    '免费档常限制「1 个并发请求」——上一次运行还没结束就再次点运行，会直接被拒',
  ],
  500: ['服务端临时故障，稍后重试'],
  502: ['服务端网关异常，稍后重试'],
  503: ['服务临时不可用，稍后重试'],
}

const NETWORK_ADVICE = [
  '该接口没有返回跨域许可头（CORS），浏览器会在请求发出前就拦掉——此时服务端日志里看不到任何记录',
  'Base URL 写错（多写或少写路径段）',
  '网络不通、需要代理，或本地代理软件拦截了请求',
]

export class LLMError extends Error {
  readonly kind: LLMErrorKind
  readonly status: number | null
  readonly endpoint: string
  readonly model: string

  constructor(init: {
    kind: LLMErrorKind
    text: string
    endpoint: string
    model: string
    status?: number | null
  }) {
    super(init.text)
    this.name = 'LLMError'
    this.kind = init.kind
    this.status = init.status ?? null
    this.endpoint = init.endpoint
    this.model = init.model
  }
}

function endpoint(config: LLMConfig): string {
  const base = config.baseUrl.trim().replace(/\/+$/, '')
  return `${base}/chat/completions`
}

function headers(config: LLMConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey.trim()}`,
  }
}

/** 把非 2xx 响应转成带排查建议的 LLMError */
async function ensureOk(response: Response, config: LLMConfig, url: string): Promise<void> {
  if (response.ok) return

  let detail = ''
  try {
    detail = (await response.text()).slice(0, 500)
  } catch {
    detail = '（无法读取响应内容）'
  }

  const advice = STATUS_ADVICE[response.status]
  const lines = [
    `模型请求失败：HTTP ${response.status}`,
    '',
    `请求地址：${url}`,
    `模型名：${config.model}`,
    `服务端返回：${detail}`,
  ]
  if (advice) {
    lines.push('', '可能原因：')
    advice.forEach((item, i) => lines.push(`${i + 1}. ${item}`))
  }
  lines.push('', '详细内容已记录到上方运行日志。')

  throw new LLMError({
    kind: 'http',
    status: response.status,
    endpoint: url,
    model: config.model,
    text: lines.join('\n'),
  })
}

/**
 * 统一包装 fetch：
 * 浏览器里被 CORS 拦掉时只会抛 `TypeError: Failed to fetch`，
 * 这里翻译成用户能照着排查的说明。
 */
async function safeFetch(
  config: LLMConfig,
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: headers(config),
      signal,
      body: JSON.stringify(body),
    })
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    const lines = [
      '请求未能发出：浏览器在发送前就中断了这次调用',
      '',
      `请求地址：${url}`,
      `模型名：${config.model}`,
      `浏览器报错：${(error as Error).message}`,
      '',
      '常见原因：',
      ...NETWORK_ADVICE.map((item, i) => `${i + 1}. ${item}`),
      '',
      '排查顺序：先用「设置 → 测试连接」确认接口是否可直连；',
      '若确认是跨域限制，可换用支持直连的服务，或部署后启用 api/llm-proxy.ts 由服务端转发。',
    ]
    throw new LLMError({
      kind: 'network',
      endpoint: url,
      model: config.model,
      text: lines.join('\n'),
    })
  }
  await ensureOk(response, config, url)
  return response
}

function parseJsonBody<T>(raw: string, config: LLMConfig, url: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new LLMError({
      kind: 'parse',
      endpoint: url,
      model: config.model,
      text: [
        '服务端返回的内容不是合法 JSON，无法解析',
        '',
        `请求地址：${url}`,
        `响应开头：${raw.slice(0, 300)}`,
        '',
        '常见原因：接口地址指向了一个网页而不是模型接口（例如把 Base URL 写成了控制台地址）。',
      ].join('\n'),
    })
  }
}

/** 非流式补全，用于规划与工具调用轮次 */
export async function completeChat(
  config: LLMConfig,
  messages: LLMMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const url = endpoint(config)
  const response = await safeFetch(
    config,
    url,
    { model: config.model, messages, temperature: config.temperature, stream: false },
    signal,
  )

  const data = parseJsonBody<{
    choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[]
    error?: { message?: string }
  }>(await response.text(), config, url)

  if (data.error?.message) {
    throw new LLMError({
      kind: 'http',
      endpoint: url,
      model: config.model,
      text: [
        '模型返回了错误信息',
        '',
        `请求地址：${url}`,
        `模型名：${config.model}`,
        `服务端返回：${data.error.message}`,
      ].join('\n'),
    })
  }

  const message = data.choices?.[0]?.message
  // 部分模型（如开启深度思考的 GLM Flash）会把内容放在 reasoning_content 里，
  // content 为空时回退取它，否则规划这类强依赖正文的场景会拿到空串。
  return message?.content?.trim() ? message.content : (message?.reasoning_content ?? '')
}

export interface ToolTurnResult {
  content: string
  toolCalls: LLMToolCall[]
  usage?: { promptTokens: number; completionTokens: number }
}

/** 一轮对话，允许模型返回工具调用 */
export async function chatTurn(
  config: LLMConfig,
  messages: LLMMessage[],
  tools: unknown[],
  signal?: AbortSignal,
): Promise<ToolTurnResult> {
  const url = endpoint(config)
  const response = await safeFetch(
    config,
    url,
    {
      model: config.model,
      messages,
      temperature: config.temperature,
      stream: false,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    },
    signal,
  )

  const data = parseJsonBody<{
    choices?: { message?: { content?: string | null; tool_calls?: LLMToolCall[] } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
    error?: { message?: string }
  }>(await response.text(), config, url)

  if (data.error?.message) {
    throw new LLMError({
      kind: 'http',
      endpoint: url,
      model: config.model,
      text: [
        '模型返回了错误信息',
        '',
        `请求地址：${url}`,
        `模型名：${config.model}`,
        `服务端返回：${data.error.message}`,
      ].join('\n'),
    })
  }

  const message = data.choices?.[0]?.message
  return {
    content: message?.content ?? '',
    toolCalls: message?.tool_calls ?? [],
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
        }
      : undefined,
  }
}

/**
 * 流式补全，按 SSE 逐段吐出 token。
 * 只解析 data: 行，遇到 [DONE] 结束。
 */
export async function* streamChat(
  config: LLMConfig,
  messages: LLMMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const url = endpoint(config)
  const response = await safeFetch(
    config,
    url,
    { model: config.model, messages, temperature: config.temperature, stream: true },
    signal,
  )
  if (!response.body) {
    throw new LLMError({
      kind: 'parse',
      endpoint: url,
      model: config.model,
      text: `响应没有可读的流（${url}）。若服务端不支持 stream:true，可改用非流式模式。`,
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[]
        }
        const delta = parsed.choices?.[0]?.delta
        // 思考过程（reasoning_content）不计入正文，否则答案里会混进推理草稿
        if (delta?.content) yield delta.content
      } catch {
        // 忽略心跳与不完整分片
      }
    }
  }
}

export interface ProbeResult {
  ok: boolean
  latencyMs: number
  endpoint: string
  model: string
  /** 服务端回显的模型名，用来确认真的是这个模型在响应 */
  echoModel?: string
  reply?: string
  error?: string
}

/**
 * 连接自检：发一次最小请求，把「配置能不能用」和「配置错在哪」分开。
 * 用户不需要跑整个 Agent 就能定位问题。
 */
export async function probeConnection(
  config: LLMConfig,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const url = endpoint(config)
  const startedAt = Date.now()
  try {
    const response = await safeFetch(
      config,
      url,
      {
        model: config.model,
        messages: [{ role: 'user', content: '回复「ok」两个字符即可，不要多余内容。' }],
        temperature: 0,
        stream: false,
      },
      signal,
    )
    const raw = await response.text()
    const data = parseJsonBody<{
      model?: string
      choices?: { message?: { content?: string | null } }[]
      usage?: { total_tokens?: number }
    }>(raw, config, url)

    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      endpoint: url,
      model: config.model,
      echoModel: data.model,
      reply: (data.choices?.[0]?.message?.content ?? '').slice(0, 60),
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      endpoint: url,
      model: config.model,
      error: (error as Error).message,
    }
  }
}
