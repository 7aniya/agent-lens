#!/usr/bin/env node
/**
 * 本地开发服务器：静态资源 + api/ 下的 Edge Function
 *
 * 存在的理由：
 * 项目的完整形态需要 /api/embed 与 /api/llm-proxy 两个服务端路由。
 * 而 `npm run dev`（vite）只服务前端，`vercel dev` 又要求先登录 Vercel 账号。
 * 这个脚本把「克隆下来就能在本地跑通完整链路」这件事补齐 ——
 * 服务端托管、混合检索、限流策略都能在本地真实地验证一遍。
 *
 * 用法：
 *   DASHSCOPE_API_KEY=sk-xxx npm run dev:api
 *
 * 环境变量（与 Vercel 上完全同名，方便照着配）：
 *   LLM_BASE_URL / LLM_API_KEY / LLM_MODEL             对话代理
 *   EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL / EMBEDDING_DIM   向量
 * 未显式提供时，会从 DASHSCOPE_API_KEY 自动推导出百炼的默认配置。
 */

import { createServer } from 'node:http'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'dist')
const PORT = Number(process.env.PORT ?? 5199)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/** 把 DASHSCOPE_API_KEY 推导成各代理需要的变量名，省得每次都写两遍 */
function applyKeyFallbacks() {
  const dashscope = process.env.DASHSCOPE_API_KEY
  if (!dashscope) return

  const defaultBase = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  process.env.EMBEDDING_API_KEY ??= dashscope
  process.env.EMBEDDING_BASE_URL ??= defaultBase
  process.env.LLM_API_KEY ??= dashscope
  process.env.LLM_BASE_URL ??= defaultBase
  process.env.LLM_MODEL ??= 'qwen-plus'
}

/** 打包 api/ 下的路由并加载，得到与 Vercel Edge Function 相同的 handler */
async function loadHandlers() {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentlens-api-'))
  await build({
    entryPoints: [
      path.join(ROOT, 'api/embed.ts'),
      path.join(ROOT, 'api/llm-proxy.ts'),
    ],
    outdir: dir,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  })

  const embed = await import(pathToFileURL(path.join(dir, 'embed.js')).href)
  const proxy = await import(pathToFileURL(path.join(dir, 'llm-proxy.js')).href)

  return {
    '/api/embed': embed.default,
    '/api/llm-proxy': proxy.default,
  }
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function serveStatic(pathname, res) {
  // 先按原路径找文件；找不到就回退到 index.html（单页应用）
  let filePath = path.join(DIST, pathname)
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  try {
    const info = await stat(filePath)
    if (info.isDirectory()) filePath = path.join(filePath, 'index.html')
  } catch {
    filePath = path.join(DIST, 'index.html')
  }

  try {
    const data = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404).end('Not found')
  }
}

applyKeyFallbacks()
const handlers = await loadHandlers()

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const handler = handlers[url.pathname]

  if (!handler) {
    await serveStatic(url.pathname === '/' ? '/index.html' : url.pathname, res)
    return
  }

  try {
    const body = await readBody(req)
    const request = new Request(url, {
      method: req.method,
      headers: {
        ...req.headers,
        // 限流依赖真实来源 IP，本地没经过网关，这里补上
        'x-forwarded-for': req.socket.remoteAddress ?? '127.0.0.1',
      },
      body,
    })

    const response = await handler(request)
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))

    if (!response.body) {
      res.end()
      return
    }

    // 必须逐块转发，不能先 arrayBuffer() 再一次性写。
    // 模型对话走的是 SSE 流，缓冲会把流式变成「等全部生成完再一次性吐出来」——
    // 用户看不到逐字输出，长回答还容易被网关判成超时。
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
    res.end()
  } catch (error) {
    console.error(`[api] ${url.pathname} 处理失败：`, error)
    // 响应头可能已经发出去了，此时再 writeHead 会抛错并让连接异常断开，
    // 浏览器侧只会看到一句信息量为零的 Failed to fetch。
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error: { code: 'DEV_SERVER_ERROR', message: String(error?.message ?? error) },
        }),
      )
    } else {
      res.end()
    }
  }
})

server.listen(PORT, '127.0.0.1', () => {
  const configured = {
    '对话代理': Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY),
    '向量代理': Boolean(process.env.EMBEDDING_API_KEY),
  }
  console.log(`AgentLens 本地全栈服务已启动：http://127.0.0.1:${PORT}`)
  console.log(`  静态资源  ${DIST}`)
  console.log(`  API 路由  ${Object.keys(handlers).join('  ')}`)
  console.log(`  密钥状态  对话代理=${configured['对话代理'] ? '已配置' : '未配置'}  向量代理=${configured['向量代理'] ? '已配置' : '未配置'}`)
  console.log('')
  console.log('  提示：未配置密钥时，页面会自动降级 —— 对话回退到 Mock，检索回退到纯 BM25。')
})
