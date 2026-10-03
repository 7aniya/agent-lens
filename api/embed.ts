/**
 * Embedding 代理（Vercel Edge Function）
 *
 * 为什么需要它，而不是让浏览器直接调百炼？
 * 因为 Key 必须留在服务端。部署到公网的作品如果让前端持有密钥，
 * 要么把 Key 明文发给每一个访客（等于公开），要么逼访客自己申请 Key（等于没人用）。
 * 服务端代理是唯一能同时做到「体验零门槛」和「密钥不泄露」的形态。
 *
 * 调用方式：POST /api/embed  { texts: string[] }
 * 返回：    { vectors: number[][], model: string, dim: number }
 *
 * 环境变量：
 *   EMBEDDING_API_KEY   Embedding 密钥；缺省时依次回退 DASHSCOPE_API_KEY、LLM_API_KEY
 *   EMBEDDING_BASE_URL  兼容 OpenAI 的 base url；默认阿里百炼兼容模式
 *   EMBEDDING_MODEL     默认 text-embedding-v3
 *   EMBEDDING_DIM       默认 512
 *
 * 关于维度选 512 而不是 1024：text-embedding-v3 支持 1024 / 768 / 512 / 256 / 128 / 64。
 * 512 维在中文短文本检索上的召回质量与 1024 维差距很小，
 * 但预计算产物的体积和余弦计算量都减半 —— 对一个要随仓库分发向量的项目来说，
 * 这个取舍是值得的。
 */

export const config = { runtime: 'edge' }

import { guardRequest, jsonError, jsonOk, readJsonBody } from './_shared/guard'

/**
 * 上游单次请求的最大条数。
 * 10 是实测值：百炼 text-embedding-v3 的 input 数组上限就是 10，
 * 超过会直接返回 400 InvalidParameter，而不是自动截断。
 * 所以这里必须自己分片，否则一次上传稍多的文档就会整批失败。
 */
const UPSTREAM_BATCH = 10

/** 单次请求允许的总条数上限 */
const MAX_TEXTS = 200

/** 单条文本截断长度，与前端 embedding.ts 的 MAX_CHARS 保持一致 */
const MAX_CHARS = 900

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const DEFAULT_MODEL = 'text-embedding-v3'
const DEFAULT_DIM = 512

interface EmbedBody {
  texts?: unknown
}

interface UpstreamEmbeddingResponse {
  data?: { index?: number; embedding?: number[] }[]
  model?: string
  usage?: Record<string, number>
  error?: { code?: string; message?: string }
}

function resolveApiKey(): string | undefined {
  return (
    process.env.EMBEDDING_API_KEY ??
    process.env.DASHSCOPE_API_KEY ??
    process.env.LLM_API_KEY
  )
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }

  if (request.method !== 'POST') {
    return jsonError(405, 'METHOD_NOT_ALLOWED', '仅支持 POST。')
  }

  const blocked = guardRequest(request, {
    scope: 'embed',
    // 一次检索只消耗 1 条查询的编码量，所以频率可以比对话宽松
    rule: { windowMs: 60_000, max: 40 },
    dailyLimit: 3000,
  })
  if (blocked) return blocked

  const apiKey = resolveApiKey()
  if (!apiKey) {
    // 501 而不是 500：这是「功能未配置」，不是「服务出错」。
    // 前端据此判定语义通道整体不可用并缓存判定，避免反复重试。
    return jsonError(
      501,
      'EMBEDDING_NOT_CONFIGURED',
      '服务端未配置 Embedding 密钥。',
      '在部署环境设置 EMBEDDING_API_KEY（或 DASHSCOPE_API_KEY）后即可启用语义检索。',
    )
  }

  const body = await readJsonBody<EmbedBody>(request)
  if (body instanceof Response) return body

  const texts = body.texts
  if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) {
    return jsonError(400, 'INVALID_TEXTS', 'texts 必须是字符串数组。')
  }
  if (texts.length === 0) {
    return jsonOk({ vectors: [], model: DEFAULT_MODEL, dim: DEFAULT_DIM })
  }
  if (texts.length > MAX_TEXTS) {
    return jsonError(400, 'TOO_MANY_TEXTS', `单次最多 ${MAX_TEXTS} 条文本。`)
  }

  const trimmed = (texts as string[]).map((t) =>
    t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t,
  )

  const baseUrl = (process.env.EMBEDDING_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = process.env.EMBEDDING_MODEL ?? DEFAULT_MODEL
  const dim = Number(process.env.EMBEDDING_DIM ?? DEFAULT_DIM)

  const vectors: number[][] = new Array(trimmed.length)
  let reportedModel = model
  let totalTokens = 0

  try {
    // 上游限制单次条数，这里按 UPSTREAM_BATCH 分片并保序回填
    for (let start = 0; start < trimmed.length; start += UPSTREAM_BATCH) {
      const slice = trimmed.slice(start, start + UPSTREAM_BATCH)

      const upstream = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: slice,
          dimensions: dim,
          encoding_format: 'float',
        }),
      })

      const payload = (await upstream.json().catch(() => null)) as
        | UpstreamEmbeddingResponse
        | null

      if (!upstream.ok || !payload || payload.error) {
        const detail = payload?.error?.message ?? `HTTP ${upstream.status}`
        // 把上游原因原样带出去。Embedding 失败的成因集中在密钥、模型名、
        // 维度不支持三处，只回一句「服务异常」会把排查方向全部堵死。
        return jsonError(
          502,
          'UPSTREAM_FAILED',
          `Embedding 服务返回错误：${detail}`,
          `请确认 EMBEDDING_MODEL（当前 ${model}）与 EMBEDDING_DIM（当前 ${dim}）在该服务上受支持。`,
        )
      }

      if (payload.model) reportedModel = payload.model
      if (payload.usage?.total_tokens) totalTokens += payload.usage.total_tokens

      for (const item of payload.data ?? []) {
        const index = typeof item.index === 'number' ? item.index : 0
        if (Array.isArray(item.embedding)) {
          vectors[start + index] = item.embedding
        }
      }
    }
  } catch (error) {
    return jsonError(
      502,
      'UPSTREAM_UNREACHABLE',
      `无法连接 Embedding 服务：${(error as Error).message}`,
      '请检查 EMBEDDING_BASE_URL 是否可达。',
    )
  }

  // 上游漏返回时补空串，保证与入参一一对应；前端会据此判定该条编码失败
  const complete = Array.from({ length: trimmed.length }, (_, i) => vectors[i] ?? [])

  return jsonOk({
    vectors: complete,
    model: reportedModel,
    dim: complete[0]?.length ?? dim,
    usage: { totalTokens },
  })
}
