#!/usr/bin/env node
/**
 * 回归测试：语料向量与查询向量必须来自同一个 embedding 模型。
 *
 * 为什么这个测试值得常驻？
 * 这个故障的表现是「一切正常、结果全错」—— 余弦相似度照样能算出一个 0~1 的数，
 * 只是那个数已经没有意义了。没有断言的话，肉眼完全看不出区别，
 * 而且它只在「部署时把 EMBEDDING_MODEL 配错」时才会出现，本地开发永远碰不到。
 *
 * 做法：用 esbuild 把真实的 runtime.ts 打包成 Node 可导入的 ESM，
 * 打桩 global.fetch 喂三种响应，观察 search() 返回的 vectorStatus 与 note。
 *
 * 用法：npm run test:signature
 */

import { build } from 'esbuild'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')

/** 造确定性假向量：只用于验证流程，不追求语义质量 */
function fakeVector(seed, dim) {
  const v = new Array(dim)
  let x = seed
  for (let i = 0; i < dim; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648
    v[i] = x / 2147483648 - 0.5
  }
  return v
}

async function setup() {
  const outDir = await mkdtemp(path.join(tmpdir(), 'agentlens-sig-'))
  await build({
    entryPoints: [
      path.join(ROOT, 'src/agent/runtime.ts'),
      path.join(ROOT, 'src/agent/corpus.ts'),
    ],
    outdir: outDir,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
    // 前端源码里有 import.meta.env.BASE_URL，Node 下不存在，构建期替换掉
    define: { 'import.meta.env': '{"BASE_URL":"/"}' },
  })

  const runtime = await import(pathToFileURL(path.join(outDir, 'runtime.js')).href)
  const { BUILTIN_CORPUS } = await import(pathToFileURL(path.join(outDir, 'corpus.js')).href)
  const artifact = JSON.parse(
    await readFile(path.join(ROOT, 'public/corpus-vectors.json'), 'utf8'),
  )
  return { runtime, BUILTIN_CORPUS, artifact }
}

/**
 * 打桩 fetch：一个喂产物文件，一个喂受控的 embedding 响应。
 *
 * 返回的向量这样构造：
 *   - 维度与产物一致时，直接回产物里的某条真实向量。
 *     否则随机向量与语料的余弦相似度接近 0，会被 MIN_COSINE 全部滤掉，
 *     「语义通道参与融合」这条断言就永远不可能成立，测试会失去意义。
 *   - 维度与产物不一致时，只能返回该维度的随机向量（这正是要触发的情形）。
 */
function stubFetch(artifact, { model, dim }) {
  const artifactVec = Object.values(artifact.vectors)[0]
  const dimMatches = dim === artifact.dim

  globalThis.fetch = async (url, init) => {
    const href = String(url)

    if (href.includes('corpus-vectors.json')) {
      return new Response(JSON.stringify(artifact), { status: 200 })
    }

    if (href.includes('/api/embed')) {
      let texts = []
      try {
        texts = JSON.parse(init?.body ?? '{}').texts ?? []
      } catch {
        texts = []
      }
      return new Response(
        JSON.stringify({
          model,
          dim,
          vectors: texts.map((t, i) =>
            dimMatches ? artifactVec : fakeVector(t.length + i + 7, dim),
          ),
        }),
        { status: 200 },
      )
    }

    return new Response('not found', { status: 404 })
  }
}

const BASE_QUERY = '储能电站热失控的早期预警依据和处置流程是什么'

async function runCase(runtime, docs, artifact, label, stub) {
  stubFetch(artifact, stub)
  runtime.invalidateRetriever()

  // 关键：每个用例用不同的查询文本。
  // 查询向量在 embedding 模块里按「文本指纹」做会话级缓存，
  // 同一个查询第二次出现时根本不会再发请求，服务端签名也就不会被更新，
  // 于是用例 B/C 会被 A 遗留的状态污染，测出「没被拦下」的假象。
  // 换一个查询文本即可强制缓存未命中，让每个用例独立成立。
  const query = `${BASE_QUERY}（场景 ${label.slice(0, 1)}）`

  const retriever = await runtime.prepareRetriever({
    docs,
    embeddingEndpoint: '/api/embed',
  })
  const { trace } = await retriever.search(query, 5)

  console.log(`=== ${label} ===`)
  console.log(`  服务端声明   model=${stub.model}  dim=${stub.dim}`)
  console.log(`  vectorStatus = ${trace.vectorStatus}`)
  console.log(`  fusion       = ${trace.fusion}`)
  console.log(
    `  词汇召回 ${trace.bm25.length} 条 / 语义召回 ${trace.vector?.length ?? 0} 条 / 融合后 ${trace.fused.length} 条`,
  )
  if (trace.note) console.log(`  note         = ${trace.note}`)
  console.log()
  return trace
}

const { runtime, BUILTIN_CORPUS, artifact } = await setup()
console.log(`产物：model=${artifact.model}  dim=${artifact.dim}  count=${artifact.count}`)
console.log()

const a = await runCase(runtime, BUILTIN_CORPUS, artifact, 'A · 服务端模型与产物一致', {
  model: artifact.model,
  dim: artifact.dim,
})
const b = await runCase(runtime, BUILTIN_CORPUS, artifact, 'B · 服务端模型与产物不一致', {
  model: 'text-embedding-v9-imaginary',
  dim: artifact.dim,
})
const c = await runCase(runtime, BUILTIN_CORPUS, artifact, 'C · 服务端维度与产物不一致', {
  model: artifact.model,
  dim: artifact.dim * 2,
})

let pass = 0
let total = 0
function assert(name, ok) {
  total += 1
  if (ok) pass += 1
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`)
}

console.log('=== 断言 ===')
assert('A 语义通道正常参与融合', a.vectorStatus === 'ok' && a.fusion === 'rrf')
assert('A 词汇与语义通道都有召回', a.bm25.length > 0 && (a.vector?.length ?? 0) > 0)

assert('B 模型不一致时被拦下', b.vectorStatus === 'failed')
assert('B 融合策略退回 bm25-only', b.fusion === 'bm25-only')
assert('B note 指出来源不一致', /不一致/.test(b.note ?? ''))
assert('B 仍返回词汇通道结果（不是白屏）', b.bm25.length > 0 && b.fused.length > 0)

assert('C 维度不一致时被拦下', c.vectorStatus === 'failed')
assert('C note 指出来源不一致', /不一致/.test(c.note ?? ''))

console.log()
console.log(`结果：${pass}/${total}`)
process.exit(pass === total ? 0 : 1)
