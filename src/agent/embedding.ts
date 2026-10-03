/**
 * 语义通道客户端
 *
 * 职责：把「文本 → 向量」这件事封装成可降级的服务。
 *
 * 三条供给路径，优先级从高到低：
 *   1. 预计算产物（/corpus-vectors.json）—— 内置语料在构建期就离线算好了，
 *      运行时零 API 调用、零延迟、零成本。这是主力路径。
 *   2. 服务端实时 embedding（/api/embed）—— 用户上传的自定义文档走这条，
 *      以及查询语句本身。每次检索只需编码 1 条查询，成本可忽略。
 *   3. 都没有 → 语义通道整体缺席，检索退化为纯 BM25（必须显性告知）。
 *
 * 为什么内置语料要预计算，而不是运行时算？
 * 如果每次打开页面都实时编码几十个切片，会有三个问题：
 *   页面首屏要多等一轮网络往返；每次演示都在烧 token；服务端一挂整个语义通道就没了。
 * 而这些向量其实是**固定的**——语料不变，向量就不变。把它挪到构建期算一次，
 * 三个问题同时消失。运行时只需要为「查询」这一条文本付费。
 */

import type { Chunk, VectorIndex } from './retrieval'
import { hashText } from './retrieval'

/**
 * 前端单次发给自己服务端的文本条数。
 * 这不是上游的限制（上游限制由服务端 api/embed.ts 分片处理），
 * 只是一个请求体积的折中：一次多带几条可以减少往返次数。
 */
const MAX_BATCH = 25

/** 单条文本送入 embedding 前的截断长度（字符）。超长文本对语义贡献递减，但会显著抬高成本 */
const MAX_CHARS = 900

export interface EmbedOptions {
  endpoint: string
  signal?: AbortSignal
}

export type EmbedFailureKind =
  | 'not-configured'
  | 'rate-limited'
  | 'upstream'
  | 'network'
  | 'model-mismatch'
  | 'unknown'

export class EmbedUnavailableError extends Error {
  kind: EmbedFailureKind
  /** 面向用户的可执行建议，直接展示在界面上 */
  hint: string

  constructor(kind: EmbedFailureKind, message: string, hint: string) {
    super(message)
    this.name = 'EmbedUnavailableError'
    this.kind = kind
    this.hint = hint
  }
}

export interface PrecomputedVectors {
  model: string
  dim: number
  generatedAt?: string
  /** chunk 文本指纹 → 向量 */
  vectors: Record<string, number[]>
}

/** 会话级向量缓存。键是文本指纹，所以语料微调后仍能命中未变化的切片。 */
const vectorCache = new Map<string, number[]>()

/**
 * 服务端实际使用的 embedding 模型签名。
 *
 * 为什么需要记这个？因为「语料向量」和「查询向量」可能来自两个不同的模型：
 * 前者是构建期用某个模型算好、随仓库分发的静态产物，
 * 后者是运行时由服务端按 EMBEDDING_MODEL 现场编码的。
 * 一旦部署时把 EMBEDDING_MODEL / EMBEDDING_DIM 配成跟产物不一致的值，
 * 两条向量就落在**不同的语义空间**里 —— 余弦相似度仍然会算出一个 0~1 的数，
 * 但它已经变成噪声。检索结果会全错，且**不报任何错**。
 *
 * 这类「看起来在正常工作、实际已经坏了」的故障最难排查，所以必须显式校验。
 */
let serverSignature: { model: string; dim: number } | null = null


/** 服务端未配置密钥时的判定缓存，避免每次检索都发一次注定失败的请求 */
let serverUnavailable: string | null = null

let precomputedPromise: Promise<PrecomputedVectors | null> | null = null

export function getVectorCacheSize(): number {
  return vectorCache.size
}

/** 重置会话级状态。仅测试使用。 */
export function __resetEmbedState(): void {
  vectorCache.clear()
  serverUnavailable = null
  precomputedPromise = null
  serverSignature = null
}

function resolveEndpoint(endpoint: string): string {
  // vite 的 base 为 './'，用 BASE_URL 拼相对路径，保证子路径部署下也能命中
  if (endpoint.startsWith('http') || endpoint.startsWith('/')) return endpoint
  return `${import.meta.env.BASE_URL ?? '/'}${endpoint}`
}

/**
 * 读取构建期产出的向量文件。
 * 只请求一次，失败也缓存结果（返回 null），避免反复打 404。
 */
export async function loadPrecomputedVectors(): Promise<PrecomputedVectors | null> {
  if (!precomputedPromise) {
    precomputedPromise = (async () => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL ?? '/'}corpus-vectors.json`, {
          cache: 'force-cache',
        })
        if (!res.ok) return null
        const data = (await res.json()) as PrecomputedVectors
        if (!data?.vectors || typeof data.vectors !== 'object') return null
        return data
      } catch {
        return null
      }
    })()
  }
  return precomputedPromise
}

/**
 * 调服务端编码文本。带会话缓存：同一段文本在整个会话里只会编码一次。
 */
export async function embedTexts(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  if (texts.length === 0) return []

  const truncated = texts.map((t) => (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t))
  const keys = truncated.map(hashText)

  const result: number[][] = new Array(texts.length)
  const missing: { index: number; key: string; text: string }[] = []

  keys.forEach((key, index) => {
    const cached = vectorCache.get(key)
    if (cached) result[index] = cached
    else missing.push({ index, key, text: truncated[index] })
  })

  if (missing.length === 0) return result

  for (let start = 0; start < missing.length; start += MAX_BATCH) {
    const slice = missing.slice(start, start + MAX_BATCH)
    const { vectors } = await requestEmbedding(
      slice.map((m) => m.text),
      opts,
    )
    slice.forEach((item, i) => {
      const vec = vectors[i]
      if (vec) {
        vectorCache.set(item.key, vec)
        result[item.index] = vec
      }
    })
  }

  return result
}

async function requestEmbedding(
  texts: string[],
  opts: EmbedOptions,
): Promise<{ vectors: number[][]; model: string | null }> {
  let res: Response
  try {
    res = await fetch(resolveEndpoint(opts.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: opts.signal,
    })
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    throw new EmbedUnavailableError(
      'network',
      '语义通道请求未发出',
      '本地开发时 /api/embed 需要 Vercel 运行时；用 `npx vercel dev` 启动，或直接使用 `npm run dev`（语义通道会自动降级为纯 BM25）。',
    )
  }

  if (!res.ok) {
    const payload = await res.json().catch(() => null)
    const code = (payload?.error?.code as string | undefined) ?? ''
    const message = (payload?.error?.message as string | undefined) ?? `HTTP ${res.status}`

    if (res.status === 501 || code === 'EMBEDDING_NOT_CONFIGURED') {
      // 记为「整体不可用」：服务端没配密钥就不可能成功，没必要每次检索都重试
      serverUnavailable = message
      throw new EmbedUnavailableError(
        'not-configured',
        message,
        '部署环境未配置 Embedding 密钥，语义通道已关闭。',
      )
    }
    if (res.status === 429 || code === 'RATE_LIMITED') {
      throw new EmbedUnavailableError('rate-limited', message, '请求过于频繁，稍后重试即可。')
    }
    throw new EmbedUnavailableError('upstream', message, 'Embedding 服务返回异常，本次检索已降级。')
  }

  const data = (await res.json()) as {
    vectors?: number[][]
    model?: string
    dim?: number
  }
  const vectors = data.vectors ?? []

  // 记下服务端真实使用的模型与维度。以「实际编码出来的向量长度」为准，
  // 而不是服务端声明的 dim —— 万一两者不一致，长度才是真正参与计算的那个值。
  const actualDim = vectors[0]?.length ?? data.dim ?? 0
  if (data.model && actualDim > 0) {
    serverSignature = { model: data.model, dim: actualDim }
  }

  return { vectors, model: data.model ?? null }
}

/**
 * 服务端实际使用的 embedding 模型签名；在首次成功编码之前为 null。
 * 供检索层校验「产物向量」与「查询向量」是否来自同一个语义空间。
 */
export function getServerEmbeddingSignature(): { model: string; dim: number } | null {
  return serverSignature
}

/** 服务端是否已被判定为不可用；用于避免无谓的探测 */
export function isServerEmbeddingUnavailable(): string | null {
  return serverUnavailable
}

export interface VectorIndexResult {
  index: VectorIndex | null
  /** 语义通道缺席时的原因说明，必须向用户展示 */
  note?: string
}

/**
 * 为当前切片集合准备向量。
 *
 * 先吃预计算产物，未命中的部分（通常是用户上传的文档）再走实时编码。
 * 这样「内置语料开箱即用 + 自定义文档按需付费」两条路径共用一套逻辑。
 *
 * 一条硬约束：**索引必须是单一来源**。
 * 产物向量由构建期的模型算出，实时向量由服务端模型算出，
 * 两者若出自不同模型就落在不同语义空间，混在一个索引里做余弦比较没有意义
 * （而且不会报错，只会让排序变成随机）。所以要么整批命中产物，
 * 要么整批交给服务端重算，不做部分复用。
 */
export async function ensureVectorIndex(
  chunks: Chunk[],
  opts: EmbedOptions,
): Promise<VectorIndexResult> {
  if (chunks.length === 0) {
    return { index: null, note: '知识库为空' }
  }

  const precomputed = await loadPrecomputedVectors()

  // 先看产物能否**完整**覆盖当前切片集合
  const artifactVectors = new Map<string, number[]>()
  if (precomputed) {
    for (const chunk of chunks) {
      const vec = precomputed.vectors[hashText(chunk.text)]
      if (vec) artifactVectors.set(chunk.id, vec)
    }
  }

  const fullyCoveredByArtifact = artifactVectors.size === chunks.length

  const vectors = new Map<string, number[]>()
  let note: string | undefined
  let reason: string | undefined

  if (fullyCoveredByArtifact) {
    for (const [id, vec] of artifactVectors) vectors.set(id, vec)
  } else {
    // 产物没命中（语料被替换）或只命中一部分（两个来源会混）→ 整批交给服务端
    if (serverUnavailable) {
      reason = serverUnavailable
    } else {
      try {
        const encoded = await embedTexts(
          chunks.map((c) => c.text),
          opts,
        )
        chunks.forEach((chunk, i) => {
          if (encoded[i]) vectors.set(chunk.id, encoded[i])
        })
      } catch (error) {
        reason = error instanceof EmbedUnavailableError ? error.message : (error as Error).message
      }
    }
  }

  if (vectors.size === 0) {
    note = reason
      ? `语义通道不可用（${reason}），本次检索退化为纯 BM25 词汇检索。`
      : '知识库中没有任何切片获得向量，本次检索退化为纯 BM25 词汇检索。'
    return { index: null, note }
  }

  // 部分覆盖时必须说清楚，否则「有些切片语义检索不到」会被误判成模型效果差
  if (vectors.size < chunks.length) {
    note = `语义通道仅覆盖 ${vectors.size}/${chunks.length} 个切片${
      reason ? `（${reason}）` : ''
    }，未覆盖部分只能靠词汇通道召回。`
  }

  // 索引的模型签名必须以**实际产出这批向量的一方**为准。
  // 这里不能想当然地取产物的 model：若非产物路径，向量的真实来源是服务端。
  const signature = getServerEmbeddingSignature()
  const fromArtifact = fullyCoveredByArtifact
  const model = fromArtifact ? (precomputed?.model ?? 'unknown') : (signature?.model ?? 'unknown')
  const dim =
    (fromArtifact ? precomputed?.dim : signature?.dim) ||
    vectors.values().next().value?.length ||
    0

  return {
    index: {
      model,
      dim,
      vectors,
      covered: vectors.size,
      total: chunks.length,
    },
    note,
  }
}
