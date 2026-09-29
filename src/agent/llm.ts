/**
 * LLM 适配层
 *
 * 只依赖 OpenAI 兼容协议（/chat/completions），因此可以对接：
 * 阿里百炼兼容模式、DeepSeek、Moonshot、智谱、Ollama、vLLM 等。
 * 换成其他协议只需要改这一个文件。
 */

import type { LLMConfig } from './types'

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: LLMToolCall[]
}

export interface LLMToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

function endpoint(config: LLMConfig): string {
  const base = config.baseUrl.replace(/\/+$/, '')
  return `${base}/chat/completions`
}

function headers(config: LLMConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  }
}

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    const body = await response.text()
    detail = body.slice(0, 300)
  } catch {
    detail = '无法读取响应内容'
  }
  if (response.status === 401) {
    throw new Error(`鉴权失败（401）：请检查 API Key 是否正确。${detail}`)
  }
  if (response.status === 404) {
    throw new Error(
      `接口不存在（404）：请检查 Base URL 是否需要包含 /v1，或模型名是否正确。${detail}`,
    )
  }
  throw new Error(`请求失败（${response.status}）：${detail}`)
}

/** 非流式补全，用于规划与工具调用轮次 */
export async function completeChat(
  config: LLMConfig,
  messages: LLMMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(endpoint(config), {
    method: 'POST',
    headers: headers(config),
    signal,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      stream: false,
    }),
  })
  await ensureOk(response)
  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  return data.choices?.[0]?.message?.content ?? ''
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
  const response = await fetch(endpoint(config), {
    method: 'POST',
    headers: headers(config),
    signal,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      stream: false,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    }),
  })
  await ensureOk(response)
  const data = (await response.json()) as {
    choices?: { message?: { content?: string; tool_calls?: LLMToolCall[] } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
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
  const response = await fetch(endpoint(config), {
    method: 'POST',
    headers: headers(config),
    signal,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      stream: true,
    }),
  })
  await ensureOk(response)
  if (!response.body) throw new Error('响应没有可读的流')

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
          choices?: { delta?: { content?: string } }[]
        }
        const delta = parsed.choices?.[0]?.delta?.content
        if (delta) yield delta
      } catch {
        // 忽略心跳与不完整分片
      }
    }
  }
}
