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

/**
 * 归一化 API Key。
 *
 * 两件事都得做，缺一个就会变成用户看不懂、还会被误导的报错：
 *  1. 剥掉零宽不可见字符（U+200B~U+200D、BOM）——从网页控制台复制时的常客，
 *     肉眼完全看不出来，服务端却会判为无效 Key 返回 401。
 *  2. 剥掉所有空白字符——Key 本身不可能含空白。尤其是换行：
 *     fetch 见到请求头里有换行会直接拒绝构造请求并抛 `Invalid value`，
 *     报错看起来像网络或跨域问题，实际只是粘贴时多选了内容。
 */
export function normalizeApiKey(apiKey: string): string {
  return apiKey.replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, '')
}

function headers(config: LLMConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${normalizeApiKey(config.apiKey)}`,
  }
}

/** 判断配置里是否真有一把能发出去的 Key：全是空白或零宽字符都算没填 */
export function hasApiKey(config: LLMConfig): boolean {
  return normalizeApiKey(config.apiKey).length > 0
}

/** 常见平台的 Key 形态，自检时用来回答「这里的 Key 应该长什么样」 */
const KEY_SHAPES: { match: RegExp; platform: string; shape: string }[] = [
  {
    match: /bigmodel\.cn/,
    platform: '智谱开放平台（open.bigmodel.cn）',
    shape: '形如 xxxxxxxx.yyyyyyyy，中间一个英文句点，约 40~50 位，不以 sk- 开头',
  },
  {
    match: /z\.ai/,
    platform: '智谱国际站（z.ai）',
    shape: '与 open.bigmodel.cn 是两套独立账号，两边 Key 不能互换',
  },
  { match: /deepseek\.com/, platform: 'DeepSeek', shape: '通常以 sk- 开头' },
  { match: /siliconflow\.cn/, platform: '硅基流动', shape: '通常以 sk- 开头' },
  { match: /aliyuncs\.com/, platform: '阿里百炼', shape: '通常以 sk- 开头' },
  { match: /openrouter\.ai/, platform: 'OpenRouter', shape: '通常以 sk-or-v1- 开头' },
  { match: /modelscope\.cn/, platform: '魔搭 ModelScope', shape: '通常以 ms- 开头' },
]

/**
 * 一条自检结论。level 决定界面上的着色：
 * info 是「我看到了什么」（供核对），warn 是「这看起来不对」。
 */
export interface KeyNote {
  level: 'info' | 'warn'
  text: string
}

/**
 * Key 自检：只根据本机填写的内容做静态判断，不联网、不上传。
 * 收到 401/403 时附在报错信息里，让用户能拿着它逐条对照控制台，
 * 而不是只看到一句「身份验证失败」猜谜。
 */
export function inspectApiKey(apiKey: string, baseUrl: string): KeyNote[] {
  const notes: KeyNote[] = []
  const key = normalizeApiKey(apiKey)
  const warn = (text: string) => notes.push({ level: 'warn', text })

  if (!key) {
    warn('API Key 为空，请先在「设置 → 模型配置」里填写')
    return notes
  }

  const shape = KEY_SHAPES.find((item) => item.match.test(baseUrl))
  const withoutInvisible = apiKey.replace(/[\u200b-\u200d\ufeff]/g, '')
  notes.push({
    level: 'info',
    text: `扣除空白与不可见字符后共 ${key.length} 个字符，前 6 位 ${key.slice(0, 6)}，后 4 位 ${key.slice(-4)}——与控制台显示的长度和首尾核对一下`,
  })

  if (apiKey !== withoutInvisible) {
    warn('Key 里含有零宽不可见字符（从网页复制时很常见），程序发送前会自动剔除')
  }
  if (withoutInvisible !== withoutInvisible.trim()) {
    warn('Key 首尾带有空格或换行，程序发送前会自动剔除')
  }
  if (/\s/.test(withoutInvisible)) {
    warn(
      'Key 中间含空格或换行，几乎可以确定是复制时多选了内容——程序会自动剔除，但建议清空后重新粘贴一遍',
    )
  }
  if (/^bearer\s+/i.test(key)) {
    warn('Key 里已经带了 "Bearer " 前缀，程序发送时会再加一次，需要把这个前缀删掉')
  }
  if (shape) {
    notes.push({ level: 'info', text: `当前接口属于 ${shape.platform}，该平台的 Key ${shape.shape}` })
  }
  if (/bigmodel\.cn/.test(baseUrl) && /^sk-/.test(key)) {
    warn(
      '以 sk- 开头的 Key 一般来自 OpenAI / DeepSeek / 硅基流动 / 百炼，不是智谱的格式——很可能是两个平台的配置串了',
    )
  }
  if (/bigmodel\.cn/.test(baseUrl) && !key.includes('.')) {
    warn('智谱的 Key 中间有一个英文句点，当前这段没有，可能只复制了一半')
  }
  if (/openrouter\.ai/.test(baseUrl) && !/^sk-or-/.test(key)) {
    warn('OpenRouter 的 Key 以 sk-or-v1- 开头，当前格式与之不符')
  }

  return notes
}

/** 抽出服务商自己的错误码与说明（智谱形如 {"error":{"code":"1000","message":"身份验证失败。"}}） */
function serverErrorBrief(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { code?: string | number; message?: string }
      code?: string | number
      message?: string
      msg?: string
    }
    const code = parsed.error?.code ?? parsed.code
    const message = parsed.error?.message ?? parsed.message ?? parsed.msg
    if (code === undefined && !message) return null
    return [code !== undefined ? `错误码 ${code}` : '', message ?? ''].filter(Boolean).join(' · ')
  } catch {
    return null
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
  const brief = serverErrorBrief(detail)
  const lines = [
    `模型请求失败：HTTP ${response.status}`,
    '',
    `请求地址：${url}`,
    `模型名：${config.model}`,
  ]
  if (brief) lines.push(`服务端说明：${brief}`)
  lines.push(`服务端返回：${detail}`)
  if (advice) {
    lines.push('', '可能原因：')
    advice.forEach((item, i) => lines.push(`${i + 1}. ${item}`))
  }
  // 认证类失败光看状态码无从下手，把本机这份 Key 的实际形态摊开，
  // 用户才能对照控制台一眼看出是「复制少了」还是「平台串了」。
  if (response.status === 401 || response.status === 403) {
    lines.push('', 'Key 自检（依据本机填写内容，不联网）：')
    inspectApiKey(config.apiKey, config.baseUrl).forEach((item) => lines.push(`· ${item.text}`))
  }
  // 智谱对「模型名写错」只会回一句模型不存在，把可用名列出来省得去翻文档
  if (
    (response.status === 400 || response.status === 404) &&
    /bigmodel\.cn/.test(config.baseUrl)
  ) {
    lines.push(
      '',
      '智谱免费档目前可用的模型名（以控制台「模型列表」为准）：',
      '· glm-4.7-flash —— 默认选择，200K 上下文',
      '· glm-4.5-flash —— 延迟更低，适合高频试跑',
      '· glm-4-flash —— 老版本，兼容性最好',
      `当前填写的是：${config.model}`,
    )
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
    const reason = (error as Error).message

    // fetch 遇到「请求地址或请求头含非法字符」时会直接抛 Invalid value，
    // 现象很像跨域或断网，实际只是粘贴的内容里混进了换行之类的空白字符。
    // 不单独识别出来的话，用户会照着「跨域」的建议白折腾半天。
    if (/invalid (value|header)/i.test(reason)) {
      throw new LLMError({
        kind: 'network',
        endpoint: url,
        model: config.model,
        text: [
          '请求未能发出：请求地址或请求头里含有非法字符',
          '',
          `请求地址：${url}`,
          `模型名：${config.model}`,
          `浏览器报错：${reason}`,
          '',
          '常见原因：Base URL 或 API Key 里混进了换行、制表符等空白字符，',
          '（粘贴时把多行内容一起复制进来最容易出现），浏览器会直接拒绝构造这个请求。',
          '',
          '处理：到「设置 → 模型配置」把 Base URL 和 API Key 清空后，重新粘贴一遍。',
        ].join('\n'),
      })
    }

    const lines = [
      '请求未能发出：浏览器在发送前就中断了这次调用',
      '',
      `请求地址：${url}`,
      `模型名：${config.model}`,
      `浏览器报错：${reason}`,
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
