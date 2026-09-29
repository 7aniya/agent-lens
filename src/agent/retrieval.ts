/**
 * 浏览器端轻量 RAG 检索
 *
 * 链路：文档 → 切分(chunk) → 建索引 → 查询 → BM25 打分 → topK
 *
 * 为什么用 BM25 而不是向量检索？
 * 向量检索需要 embedding 模型，要么依赖后端、要么依赖 API Key，
 * 会让「clone 下来就能跑」这个目标失效。
 * BM25 是纯计算、零依赖的，且中文场景下按二元组切分效果可接受，
 * 足以让使用者看清「检索—排序—拼装」这条链路。
 * 生产环境应替换为「向量粗召 + 重排序」的两阶段链路。
 */

import type { RetrievalHit } from './types'
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

/**
 * BM25 打分。返回按相关度降序的命中列表。
 * score 字段做了 min-max 归一化，便于 UI 直接展示成百分比。
 */
export function search(
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

  return top.map(({ chunk, score }) => ({
    chunkId: chunk.id,
    docId: chunk.docId,
    docTitle: chunk.docTitle,
    snippet: buildSnippet(chunk.text, queryTokens),
    score: Math.round((score / max) * 100) / 100,
  }))
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
