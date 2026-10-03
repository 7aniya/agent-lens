/**
 * LLM 请求代理（Vercel Edge Function）
 *
 * 什么时候需要它？
 * 部分模型服务未对浏览器开放 CORS，此时前端直连会被浏览器拦截；
 * 更重要的是**部署到公网时密钥不能放在前端** —— 那等于把 Key 公开给每个访客。
 * 把请求转发到同源的 /api/llm-proxy，密钥留在服务端环境变量里，两个问题一起解决。
 *
 * 前端如何接入？
 * 把「设置 → 模型配置」的 Base URL 改成 `/api/llm-proxy`（同源相对路径）即可。
 * 注意：此时前端**不发送** Authorization 头，密钥完全由本函数持有。
 *
 * 环境变量：
 *   LLM_API_KEY   模型服务密钥（必填）
 *   LLM_BASE_URL  兼容 OpenAI 的 base url（必填）
 *   LLM_MODEL     锁定的模型名（可选；一旦设置，前端传入的 model 将被忽略）
 */

export const config = { runtime: 'edge' }

import { guardRequest, jsonError, jsonOk, readJsonBody } from './_shared/guard'

/**
 * 单次生成的输出上限。
 * 不设上限时，任何拿到这个公开链接的人都能请求一次生成上万 token，
 * 单次调用就足以吃掉可观额度。这是最廉价也最有效的一道成本闸门。
 */
const MAX_OUTPUT_TOKENS = 2048

/** 请求体上限：上下文过长既烧钱，也容易被用来做消耗型攻击 */
const MAX_BODY_BYTES = 256 * 1024

interface ProxyBody {
  model?: string
  messages?: unknown[]
  tools?: unknown[]
  temperature?: number
  stream?: boolean
  max_tokens?: number
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }

  // 健康检查：前端在运行真实模型之前先探一次，用来区分
  // 「服务端没配密钥」和「代理压根不可达」——两者该有不同的处理，
  // 前者要干净地降级到 Mock，后者才应该报错。
  // 这里刻意不走限流：它不消耗任何上游额度，拦它反而会让降级判断失真。
  if (request.method === 'GET') {
    const configured = Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY)
    if (!configured) {
      return jsonError(
        501,
        'LLM_NOT_CONFIGURED',
        '服务端未配置模型密钥，无法使用真实模型。',
        '在部署环境设置 LLM_BASE_URL 与 LLM_API_KEY 后即可启用；在此之前可以切到 Mock 模式体验完整链路。',
      )
    }
    return jsonOk({ configured: true, model: process.env.LLM_MODEL ?? null })
  }

  if (request.method !== 'POST') {
    return jsonError(405, 'METHOD_NOT_ALLOWED', '仅支持 POST。')
  }

  const blocked = guardRequest(request, {
    scope: 'llm',
    // 一次完整运行会连打多轮（规划 + 若干轮工具调用 + 最终回答），
    // 所以窗口内要给到几十次，否则正常使用就会撞上自己的限流。
    rule: { windowMs: 60_000, max: 30 },
    dailyLimit: 400,
  })
  if (blocked) return blocked

  const baseUrl = process.env.LLM_BASE_URL
  const apiKey = process.env.LLM_API_KEY

  if (!baseUrl || !apiKey) {
    return jsonError(
      501,
      'LLM_NOT_CONFIGURED',
      '服务端未配置模型密钥，无法使用真实模型。',
      '在部署环境设置 LLM_BASE_URL 与 LLM_API_KEY 后即可启用；在此之前可以切到 Mock 模式体验完整链路。',
    )
  }

  const body = await readJsonBody<ProxyBody>(request, MAX_BODY_BYTES)
  if (body instanceof Response) return body

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(400, 'INVALID_MESSAGES', 'messages 必须是非空数组。')
  }

  // 模型名由服务端说了算：开放前端随意指定，等于让一个公开链接
  // 有能力调用该平台上的任意（可能昂贵的）模型。
  const model = process.env.LLM_MODEL ?? body.model ?? 'qwen-plus'

  const requestedMaxTokens = Number(body.max_tokens)
  const maxTokens =
    Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
      ? Math.min(requestedMaxTokens, MAX_OUTPUT_TOKENS)
      : MAX_OUTPUT_TOKENS

  const upstreamUrl = `${baseUrl.replace(/\/+$/, '')}/chat/completions`

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: body.messages,
        ...(Array.isArray(body.tools) && body.tools.length > 0
          ? { tools: body.tools, tool_choice: 'auto' }
          : {}),
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.3,
        max_tokens: maxTokens,
        stream: body.stream === true,
      }),
    })
  } catch (error) {
    return jsonError(
      502,
      'UPSTREAM_UNREACHABLE',
      `无法连接模型服务：${(error as Error).message}`,
      '请检查部署环境的 LLM_BASE_URL 是否可达。',
    )
  }

  if (!upstream.ok) {
    // 把上游原始信息透出去便于定位，但只截取错误正文，不涉及任何请求头或密钥
    const detail = await upstream.text().catch(() => '')
    return jsonError(
      502,
      'UPSTREAM_FAILED',
      `模型服务返回 HTTP ${upstream.status}${detail ? `：${detail.slice(0, 300)}` : ''}`,
      '常见原因是部署环境的 LLM_API_KEY 无效、额度耗尽，或 LLM_MODEL 名称在该平台不存在。',
    )
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}
