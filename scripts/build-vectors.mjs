#!/usr/bin/env node
/**
 * 预计算内置语料的向量，产出 public/corpus-vectors.json
 *
 * 用法：
 *   DASHSCOPE_API_KEY=sk-xxx npm run vectors
 *
 * 为什么用 esbuild 打包而不是在脚本里重新实现一遍切分？
 * 因为「脚本切出来的切片」和「浏览器切出来的切片」必须逐字一致，
 * 否则哈希对不上，缓存的向量会全部落空 —— 而且不会有任何报错，
 * 只是语义检索悄悄退化成纯 BM25，极难察觉。
 * 唯一能保证一致的办法就是复用同一份代码，所以这里直接把
 * src/agent 下的模块打包出来 import，而不是抄一遍逻辑。
 *
 * 产物为什么要入库？
 * 因为它让部署后的语义检索变成「零 API 调用」：访客提问时只需要为
 * 那一句查询编码一次，其余向量都是静态资源。语料不变时也不需要重新生成。
 */

import { build } from 'esbuild'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT_FILE = path.join(ROOT, 'public', 'corpus-vectors.json')

const API_KEY =
  process.env.EMBEDDING_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? process.env.LLM_API_KEY
const BASE_URL = (process.env.EMBEDDING_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '')
const MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-v3'
const DIM = Number(process.env.EMBEDDING_DIM ?? 512)

/**
 * 上游单次最大条数。
 * 注意这是实测值而不是猜的：百炼 text-embedding-v3 对 input 数组的限制是 10，
 * 超过会直接返回 400 InvalidParameter「batch size is invalid, it should not be larger than 10」。
 */
const BATCH = 10

/** 保留小数位。6 位远超实际需要的精度，同时显著压缩产物体积 */
const PRECISION = 6

function log(step, text) {
  console.log(`[${step}] ${text}`)
}

function fail(message, hint) {
  console.error(`\n✗ ${message}`)
  if (hint) console.error(`  ${hint}`)
  process.exit(1)
}

/** 打包并加载 src/agent 下的模块，保证与浏览器端是同一份实现 */
async function loadAgentModules() {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentlens-vectors-'))
  await build({
    entryPoints: [
      path.join(ROOT, 'src/agent/corpus.ts'),
      path.join(ROOT, 'src/agent/retrieval.ts'),
    ],
    outdir: dir,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  })
  const corpus = await import(pathToFileURL(path.join(dir, 'corpus.js')).href)
  const retrieval = await import(pathToFileURL(path.join(dir, 'retrieval.js')).href)
  return { corpus, retrieval, dir }
}

async function embedBatch(texts) {
  const response = await fetch(`${BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      input: texts,
      dimensions: DIM,
      encoding_format: 'float',
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    fail(
      `Embedding 接口返回 HTTP ${response.status}`,
      `${detail.slice(0, 400)}\n  当前配置：model=${MODEL} dim=${DIM} baseUrl=${BASE_URL}`,
    )
  }

  const payload = await response.json()
  if (payload.error) {
    fail(`Embedding 接口返回错误：${payload.error.message}`)
  }

  const vectors = new Array(texts.length)
  let tokens = 0
  for (const item of payload.data ?? []) {
    vectors[item.index] = item.embedding
  }
  if (payload.usage?.total_tokens) tokens = payload.usage.total_tokens
  return { vectors, tokens }
}

async function main() {
  if (!API_KEY) {
    fail(
      '未找到 Embedding 密钥。',
      '请通过环境变量提供：DASHSCOPE_API_KEY=sk-xxx npm run vectors',
    )
  }

  log('1/5', '打包 src/agent 模块（复用浏览器端的切分与哈希实现）…')
  const { corpus, retrieval } = await loadAgentModules()

  log('2/5', '切分内置语料…')
  const chunks = retrieval.chunkDocuments(corpus.BUILTIN_CORPUS, retrieval.DEFAULT_CHUNK_OPTIONS)
  log('  ·', `语料 ${corpus.BUILTIN_CORPUS.length} 篇 → ${chunks.length} 个切片`)

  // 去重：内容完全相同的切片只编码一次
  const byHash = new Map()
  for (const chunk of chunks) {
    const hash = retrieval.hashText(chunk.text)
    if (byHash.has(hash) && byHash.get(hash).text !== chunk.text) {
      // 32 位指纹撞了，且不是同一段文本 —— 必须停下，否则向量会被覆盖成错的
      fail(
        `哈希碰撞：${chunk.id} 与 ${byHash.get(hash).id} 指纹相同但内容不同。`,
        '请换用更长的指纹（例如拼接两个不同种子的 FNV-1a）。',
      )
    }
    if (!byHash.has(hash)) byHash.set(hash, chunk)
  }
  const unique = Array.from(byHash.entries())
  log('  ·', `去重后需要编码 ${unique.length} 段唯一文本`)

  log('3/5', `调用 ${MODEL}（${DIM} 维）编码…`)
  const startedAt = Date.now()
  let totalTokens = 0
  const vectors = {}

  for (let start = 0; start < unique.length; start += BATCH) {
    const slice = unique.slice(start, start + BATCH)
    const { vectors: encoded, tokens } = await embedBatch(slice.map(([, chunk]) => chunk.text))
    totalTokens += tokens
    slice.forEach(([hash], i) => {
      const vec = encoded[i]
      if (!vec || vec.length === 0) {
        fail(`第 ${start + i + 1} 段文本没有拿到向量`)
      }
      vectors[hash] = vec.map((v) => Number(v.toFixed(PRECISION)))
    })
    log('  ·', `已完成 ${Math.min(start + BATCH, unique.length)}/${unique.length}`)
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)

  log('4/5', '写入产物…')
  const payload = {
    model: MODEL,
    dim: DIM,
    generatedAt: new Date().toISOString(),
    count: Object.keys(vectors).length,
    vectors,
  }
  await mkdir(path.dirname(OUT_FILE), { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(payload), 'utf8')

  log('5/5', '完成')
  console.log('')
  console.log(`  产物      ${path.relative(ROOT, OUT_FILE)}`)
  console.log(`  向量数    ${Object.keys(vectors).length}`)
  console.log(`  维度      ${DIM}`)
  console.log(`  消耗 token ${totalTokens}`)
  console.log(`  耗时      ${elapsed}s`)
  console.log('')
  console.log('  提示：语料变更后才需要重新生成；未变更时可以继续使用已有产物。')
}

main().catch((error) => {
  fail(`生成失败：${error?.message ?? error}`)
})
