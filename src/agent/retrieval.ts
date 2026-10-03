/**
 * 混合检索：词汇通道 + 语义通道 + RRF 融合
 *
 * 链路：
 *   查询 ┬─ BM25（本地，零依赖）───────────┐
 *        └─ 向量召回（Embedding + 余弦）──┤
 *                                        └─ RRF 融合 → topK
 *
 * 为什么保留 BM25，而不是直接用向量检索替掉它？
 * 因为两者失败的方式不一样，互补性才是重点：
 *   - BM25 对「专有名词、型号、编号」几乎不会失手，但问法和原文不一致时召回为 0；
 *   - 向量对「换个说法问同一件事」很擅长，但对罕见词容易召回到语义相近却事实无关的内容。
 * 两条通道并排跑，命中情况可以互相印证（都命中 = 可信度高），
 * 也可以互相兜底（一条为 0 时另一条还在）。这是单通道做不到的。
 *
 * 为什么融合用 RRF 而不是分数加权求和？
 * BM25 分数是「无上界的正数」，余弦相似度是「-1~1」，两者量纲完全不同。
 * 加权求和要先调归一化和权重，参数一多变调参就变成玄学，换个语料还得重调。
 * RRF 只用**排名**不用分数：
 *   score(d) = Σ 1 / (k + rank_i(d))
 * 对量纲免疫，是个稳健得多的默认选择，代价是丢弃了分数差距信息。
 * 需要精细控制时再上「加权 + 重排序」，那是下一步的事。
 */

import type { RetrievalChannel, RetrievalHit } from './types'
import type { KnowledgeDoc } from './corpus'

export interface Chunk {
  id: string
  docId: string
  docTitle: string
  source: string
  text: string
  index: number
  tokens: string[]
}

export interface ChunkOptions {
  /** 目标块大小（字符数） */
  size: number
  /** 相邻块重叠比例 0~0.5 */
  overlap: number
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { size: 220, overlap: 0.15 }

/**
 * 文本指纹，用于把向量产物与「切分算法」解耦。
 *
 * 关键设计：向量缓存的键是**切片文本的指纹**，而不是 `docId#index` 这样的位置 ID。
 * 如果键用位置 ID，那只要调整一次切分参数（块大小、重叠比例），
 * 全部缓存的向量就会错位到别的文本上——而且是静默错位，检索质量悄悄劣化，
 * 排查起来极其困难。用内容指纹就没这个问题：文本没变就命中，文本变了就 miss 重算，
 * 最多损失缓存命中率，绝不会用错向量。
 *
 * 用 FNV-1a 而不是 SHA-256 是因为它同步、无依赖；
 * 语料规模在千条量级，32 位指纹的碰撞概率可以忽略（约 1e-7），
 * 且构建脚本会主动检测碰撞。
 */
export function hashText(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 中文按二元组切分，英文数字按词切分。返回小写 token 列表。 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []

  const latin = lower.match(/[a-z0-9][a-z0-9_+-]*/g)
  if (latin) tokens.push(...latin)

  const cjkSegments = lower.match(/[\u4e00-\u9fa5]+/g)
  if (cjkSegments) {
    for (const seg of cjkSegments) {
      if (seg.length === 1) {
        tokens.push(seg)
        continue
      }
      for (let i = 0; i < seg.length - 1; i += 1) {
        tokens.push(seg.slice(i, i + 2))
      }
    }
  }
  return tokens
}

/** 按段落优先、长度兜底的方式切分文档，并保留重叠。 */
export function chunkDocuments(
  docs: KnowledgeDoc[],
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Chunk[] {
  const { size, overlap } = options
  const step = Math.max(1, Math.floor(size * (1 - overlap)))
  const chunks: Chunk[] = []

  for (const doc of docs) {
    // 先按空行拆段落，再把段落贪心拼装到接近 size
    const paragraphs = doc.content
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)

    const buffers: string[] = []
    let current = ''
    for (const p of paragraphs) {
      if (current.length + p.length > size && current.length > 0) {
        buffers.push(current)
        current = p
      } else {
        current = current ? `${current}\n${p}` : p
      }
    }
    if (current) buffers.push(current)

    // 对超长块按固定长度硬切，并带重叠
    const pieces: string[] = []
    for (const buf of buffers) {
      if (buf.length <= size * 1.4) {
        pieces.push(buf)
        continue
      }
      for (let start = 0; start < buf.length; start += step) {
        pieces.push(buf.slice(start, start + size))
      }
    }

    pieces.forEach((text, index) => {
      chunks.push({
        id: `${doc.id}#${index}`,
        docId: doc.id,
        docTitle: doc.title,
        source: doc.source,
        text,
        index,
        tokens: tokenize(text),
      })
    })
  }
  return chunks
}

const K1 = 1.5
const B = 0.75

/** RRF 平滑常数。60 取自原论文经验值：越大则头部排名优势越被削弱、融合越保守。 */
export const RRF_K = 60

/**
 * 语义通道的最低余弦相似度。
 * 没有这个阈值时，哪怕库里全是不相关内容，top1 归一化后也永远显示 100%，
 * 用户会以为「检索到了」——而实际上什么都没召回。加个下限，
 * 让「检索不到」这件事能被真实地表达出来。
 */
export const MIN_COSINE = 0.25

export interface RetrievalIndex {
  chunks: Chunk[]
  /** token → 文档频次 */
  df: Map<string, number>
  /** chunkId → token 频次表 */
  tf: Map<string, Map<string, number>>
  avgLength: number
}

export function buildIndex(chunks: Chunk[]): RetrievalIndex {
  const df = new Map<string, number>()
  const tf = new Map<string, Map<string, number>>()
  let totalLength = 0

  for (const chunk of chunks) {
    const freq = new Map<string, number>()
    for (const token of chunk.tokens) {
      freq.set(token, (freq.get(token) ?? 0) + 1)
    }
    tf.set(chunk.id, freq)
    totalLength += chunk.tokens.length
    for (const token of freq.keys()) {
      df.set(token, (df.get(token) ?? 0) + 1)
    }
  }

  return {
    chunks,
    df,
    tf,
    avgLength: chunks.length ? totalLength / chunks.length : 1,
  }
}

/* ------------------------------------------------------------------ */
/* 语义侧：向量存储与计算                                               */
/* ------------------------------------------------------------------ */

/** 语义通道的向量集合，按 chunkId 索引 */
export interface VectorIndex {
  model: string
  dim: number
  /** chunkId → 向量 */
  vectors: Map<string, number[]>
  /** 已有向量的切片数 / 总切片数，用于在界面上暴露「覆盖率不足」 */
  covered: number
  total: number
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** 把一组分数 min-max 归一化到 0~1，与 BM25 通道的展示口径保持一致。 */
function normalize(raw: number[]): number[] {
  if (raw.length === 0) return []
  const max = Math.max(...raw)
  const min = Math.min(...raw)
  if (max === min) return raw.map(() => 1)
  return raw.map((v) => Math.round(((v - min) / (max - min)) * 100) / 100)
}

/**
 * 语义召回：查询向量与每个切片向量做余弦相似度，取 topK。
 * 低于 MIN_COSINE 的一律丢弃（见该常量的说明）。
 */
export function searchVector(
  index: RetrievalIndex,
  vectors: VectorIndex,
  queryVector: number[],
  topK = 5,
): RetrievalHit[] {
  if (index.chunks.length === 0 || queryVector.length === 0) return []

  const scored: { chunk: Chunk; cos: number }[] = []
  for (const chunk of index.chunks) {
    const vec = vectors.vectors.get(chunk.id)
    if (!vec) continue
    const cos = cosineSimilarity(queryVector, vec)
    if (cos >= MIN_COSINE) scored.push({ chunk, cos })
  }

  scored.sort((a, b) => b.cos - a.cos)
  const top = scored.slice(0, topK)
  const normalized = normalize(top.map((s) => s.cos))

  return top.map(({ chunk }, i) => ({
    chunkId: chunk.id,
    docId: chunk.docId,
    docTitle: chunk.docTitle,
    // 语义通道没有词命中，用全文开头做片段（切片本身只有 220 字，不需要截断太多）
    snippet: buildSnippet(chunk.text, []),
    score: normalized[i],
    vectorScore: normalized[i],
    channels: ['vector' as RetrievalChannel],
  }))
}

/* ------------------------------------------------------------------ */
/* 词汇侧：BM25                                                        */
/* ------------------------------------------------------------------ */

/**
 * BM25 打分。返回按相关度降序的命中列表。
 * score 字段做了 min-max 归一化，便于 UI 直接展示成百分比。
 */
export function searchBM25(
  index: RetrievalIndex,
  query: string,
  topK = 5,
): RetrievalHit[] {
  const queryTokens = Array.from(new Set(tokenize(query)))
  if (queryTokens.length === 0 || index.chunks.length === 0) return []

  const N = index.chunks.length
  const raw: { chunk: Chunk; score: number }[] = []

  for (const chunk of index.chunks) {
    const freq = index.tf.get(chunk.id)
    if (!freq) continue
    const length = chunk.tokens.length || 1
    let score = 0

    for (const token of queryTokens) {
      const f = freq.get(token)
      if (!f) continue
      const dfValue = index.df.get(token) ?? 0
      const idf = Math.log(1 + (N - dfValue + 0.5) / (dfValue + 0.5))
      const denominator = f + K1 * (1 - B + (B * length) / index.avgLength)
      score += idf * ((f * (K1 + 1)) / denominator)
    }
    if (score > 0) raw.push({ chunk, score })
  }

  raw.sort((a, b) => b.score - a.score)
  const top = raw.slice(0, topK)
  const max = top.length ? top[0].score : 1

  return top.map(({ chunk, score }) => {
    const normalized = Math.round((score / max) * 100) / 100
    return {
      chunkId: chunk.id,
      docId: chunk.docId,
      docTitle: chunk.docTitle,
      snippet: buildSnippet(chunk.text, queryTokens),
      score: normalized,
      bm25Score: normalized,
      channels: ['bm25' as RetrievalChannel],
    }
  })
}

/* ------------------------------------------------------------------ */
/* 融合                                                                */
/* ------------------------------------------------------------------ */

/**
 * Reciprocal Rank Fusion。
 *
 * 只用排名不用分数，所以对两个通道的量纲差异免疫。
 * 多通道同时命中的切片会拿到两次累加，自然排到前面 ——
 * 这正是我们想要的：两个独立信号都指向它，可信度更高。
 */
export function rrfFusion(
  bm25Hits: RetrievalHit[],
  vectorHits: RetrievalHit[],
  topK = 5,
): RetrievalHit[] {
  interface Entry {
    hit: RetrievalHit
    score: number
    channels: Set<RetrievalChannel>
  }

  const acc = new Map<string, Entry>()

  const add = (hits: RetrievalHit[], channel: RetrievalChannel) => {
    hits.forEach((hit, rank) => {
      const contribution = 1 / (RRF_K + rank + 1)
      const existing = acc.get(hit.chunkId)
      if (existing) {
        existing.score += contribution
        existing.channels.add(channel)
        // 保留两个通道各自的分数，界面上可以并排看到「谁贡献了这条」
        if (channel === 'bm25') existing.hit.bm25Score = hit.bm25Score
        else existing.hit.vectorScore = hit.vectorScore
      } else {
        acc.set(hit.chunkId, {
          hit: { ...hit },
          score: contribution,
          channels: new Set<RetrievalChannel>([channel]),
        })
      }
    })
  }

  add(bm25Hits, 'bm25')
  add(vectorHits, 'vector')

  const merged = Array.from(acc.values())
  merged.sort((a, b) => b.score - a.score)

  const top = merged.slice(0, topK)
  const maxScore = top.length ? top[0].score : 1

  return top.map((entry) => {
    const channels = (['bm25', 'vector'] as RetrievalChannel[]).filter((c) =>
      entry.channels.has(c),
    )
    const fused = Math.round((entry.score / maxScore) * 100) / 100
    return {
      ...entry.hit,
      channels,
      rrfScore: fused,
      // 展示分数统一用 RRF 归一化值；两通道各自的原始分保留在
      // bm25Score / vectorScore 上，便于并排比较
      score: fused,
    }
  })
}

/** 截取包含命中词的片段，并在词前后留出上下文，提升可读性。 */
function buildSnippet(text: string, queryTokens: string[], maxLength = 120): string {
  const lower = text.toLowerCase()
  let hitIndex = -1

  for (const token of queryTokens) {
    const idx = lower.indexOf(token)
    if (idx >= 0 && (hitIndex === -1 || idx < hitIndex)) hitIndex = idx
  }

  if (hitIndex === -1) {
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`
  }

  const start = Math.max(0, hitIndex - Math.floor(maxLength / 3))
  const end = Math.min(text.length, start + maxLength)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\n/g, ' ')}${
    end < text.length ? '…' : ''
  }`
}

/** 兼容旧调用点：等价于纯词汇检索 */
export const search = searchBM25
