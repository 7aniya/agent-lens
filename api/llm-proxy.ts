/**
 * 可选：LLM 请求代理（Vercel Edge Function）
 *
 * 什么时候需要它？
 * 部分模型服务未对浏览器开放 CORS，此时前端直连会被浏览器拦截。
 * 把请求转发到同源的 /api/llm-proxy 即可绕开限制。
 *
 * 安全的做法是：API Key 放在服务端环境变量里，前端只传模型名与消息。
 * 部署到 Vercel 后，在项目设置中添加环境变量 LLM_BASE_URL / LLM_API_KEY，
 * 然后把前端「设置」里的 Base URL 改成 `/api/llm-proxy` 即可。
 */

export const config = { runtime: 'edge' }

interface ProxyBody {
  model?: string
  messages?: unknown[]
  tools?: unknown[]
  temperature?: number
  stream?: boolean
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: '仅支持 POST' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const baseUrl = process.env.LLM_BASE_URL
  const apiKey = process.env.LLM_API_KEY

  if (!baseUrl || !apiKey) {
    return new Response(
      JSON.stringify({
        error:
          '未配置服务端密钥。请在部署环境中设置 LLM_BASE_URL 与 LLM_API_KEY，或改回前端直连模式。',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }

  let body: ProxyBody
  try {
    body = (await request.json()) as ProxyBody
  } catch {
    return new Response(JSON.stringify({ error: '请求体不是合法 JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const upstream = await fetch(
    `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: body.model ?? process.env.LLM_MODEL ?? 'qwen-plus',
        messages: body.messages ?? [],
        ...(body.tools && body.tools.length > 0
          ? { tools: body.tools, tool_choice: 'auto' }
          : {}),
        temperature: body.temperature ?? 0.3,
        stream: body.stream ?? false,
      }),
    },
  )

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}
