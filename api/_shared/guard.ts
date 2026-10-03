/**
 * 服务端防护：限流、日预算、统一错误响应
 *
 * 为什么需要这一层？
 * 部署版把百炼 Key 放在服务端，读者打开链接就能直接用 —— 这消除了使用门槛，
 * 但也意味着**任何拿到这个链接的人都在花你的钱**。一个被转发到群里的简历链接
 * 完全可能在一夜之间把额度跑光。所以公开可用的 LLM 代理必须有闸门。
 *
 * 这一层的诚实说明（不藏着）：
 * Vercel 的 Edge Function 是无状态、多实例、随时冷启的，所以这里的计数器
 * 只对**单个实例**有效，跨实例并不共享。攻击者并发打满时，实际放行量会是
 * 「实例数 × 单实例上限」。这挡得住误用与脚本小子，挡不住有预谋的分布式刷取。
 * 真正的兜底手段是在百炼控制台给 Key 设一个额度上限 —— 那是钱的最后一道防线，
 * 不依赖任何应用层逻辑。README 里也写明了这一点。
 */

export interface RateLimitRule {
  /** 窗口长度（毫秒） */
  windowMs: number
  /** 窗口内允许的最大请求数 */
  max: number
}

export interface RateLimitResult {
  ok: boolean
  /** 建议的 Retry-After 秒数 */
  retryAfterSec: number
  remaining: number
}

/** key → 命中时间戳列表（滑动窗口） */
const buckets = new Map<string, number[]>()

/** scope → { day, count }（自然日计数，用于总额熔断） */
const dailyCounters = new Map<string, { day: string; count: number }>()

/** 条目过多时清理陈旧数据，避免边缘实例长期驻留导致内存膨胀 */
const MAX_KEYS = 5000

function sweep(now: number, windowMs: number): void {
  if (buckets.size < MAX_KEYS) return
  for (const [key, hits] of buckets) {
    const alive = hits.filter((t) => now - t < windowMs)
    if (alive.length === 0) buckets.delete(key)
    else buckets.set(key, alive)
  }
}

export function checkRateLimit(key: string, rule: RateLimitRule): RateLimitResult {
  const now = Date.now()
  sweep(now, rule.windowMs)

  const hits = (buckets.get(key) ?? []).filter((t) => now - t < rule.windowMs)

  if (hits.length >= rule.max) {
    const oldest = hits[0]
    const retryAfterSec = Math.max(1, Math.ceil((rule.windowMs - (now - oldest)) / 1000))
    buckets.set(key, hits)
    return { ok: false, retryAfterSec, remaining: 0 }
  }

  hits.push(now)
  buckets.set(key, hits)
  return { ok: true, retryAfterSec: 0, remaining: rule.max - hits.length }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 自然日总额熔断。
 * 限流约束的是「频率」，预算约束的是「总量」—— 两者都需要。
 * 只限流的话，一个缓慢但持续的爬取仍然能跑完整月额度。
 */
export function checkDailyBudget(scope: string, limit: number): { ok: boolean; used: number } {
  const day = today()
  const entry = dailyCounters.get(scope)

  if (!entry || entry.day !== day) {
    dailyCounters.set(scope, { day, count: 1 })
    return { ok: true, used: 1 }
  }

  if (entry.count >= limit) return { ok: false, used: entry.count }

  entry.count += 1
  return { ok: true, used: entry.count }
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    hint?: string
  }
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  hint?: string,
  extraHeaders?: Record<string, string>,
): Response {
  const body: ApiErrorBody = { error: { code, message, ...(hint ? { hint } : {}) } }
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(extraHeaders ?? {}),
    },
  })
}

export function jsonOk(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

/** 读取 JSON body，同时限制体积，避免超大请求体打满内存 */
export async function readJsonBody<T>(
  request: Request,
  maxBytes = 256 * 1024,
): Promise<T | Response> {
  const raw = await request.text()
  if (raw.length > maxBytes) {
    return jsonError(413, 'PAYLOAD_TOO_LARGE', `请求体超过 ${Math.round(maxBytes / 1024)}KB 上限。`)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return jsonError(400, 'INVALID_JSON', '请求体不是合法 JSON。')
  }
}

/**
 * 组装一次请求通用的闸门检查。
 * 返回 Response 表示被拦截，调用方直接返回它即可。
 */
export function guardRequest(
  request: Request,
  options: {
    scope: string
    rule: RateLimitRule
    dailyLimit: number
  },
): Response | null {
  const ip = clientIp(request)

  const rate = checkRateLimit(`${options.scope}:${ip}`, options.rule)
  if (!rate.ok) {
    return jsonError(
      429,
      'RATE_LIMITED',
      `请求过于频繁，请 ${rate.retryAfterSec} 秒后再试。`,
      '这是公开演示环境，为避免额度被瞬间耗尽做了频率限制。',
      { 'Retry-After': String(rate.retryAfterSec) },
    )
  }

  const budget = checkDailyBudget(options.scope, options.dailyLimit)
  if (!budget.ok) {
    return jsonError(
      429,
      'DAILY_BUDGET_EXCEEDED',
      '今日演示额度已用完。',
      '这是公开演示环境，每日调用总量有限。可以拉取仓库、填入自己的 API Key 后本地运行。',
    )
  }

  return null
}
