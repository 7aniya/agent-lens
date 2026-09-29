/**
 * 模型服务预设
 *
 * 收录的都是「OpenAI 兼容 + 浏览器可直连」的服务，两者缺一不可：
 * 前者决定 llm.ts 能不能复用，后者决定前端能不能绕过 CORS 直连。
 *
 * 已实测的跨域情况（2026-09）：
 *   /api/paas/v4（智谱）      → 回显 Origin，放行 authorization 头 ✅
 *   /v1（DeepSeek）           → 回显 Origin，放行 authorization 头 ✅
 *   /v1（硅基流动）           → Access-Control-Allow-Origin: *      ✅
 *   /v1（魔搭 ModelScope）    → Access-Control-Allow-Origin: *      ✅
 *   /compatible-mode/v1（百炼）→ Access-Control-Allow-Origin: *      ✅
 *   /api/v1（OpenRouter）     → Access-Control-Allow-Origin: *      ✅
 *   /api/paas/v4（z.ai 国际） → 无 CORS 头，必须走服务端代理        ❌
 */

import type { LLMConfig } from './types'

export interface ProviderPreset {
  id: string
  /** 展示名 */
  name: string
  /** 一句话说明免费政策，写清楚「永久免费」还是「注册赠送」 */
  freeNote: string
  /** 是否永久免费（用于界面上的小标签） */
  permanentFree: boolean
  /** 是否已实测支持浏览器直连 */
  corsOk: boolean
  /** 申请 Key 的地址 */
  signupUrl: string
  config: Pick<LLMConfig, 'baseUrl' | 'model'>
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'zhipu',
    name: '智谱 GLM',
    freeNote: 'GLM-4.7-Flash 永久免费 · 200K 上下文 · 支持工具调用',
    permanentFree: true,
    corsOk: true,
    signupUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    config: {
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.7-flash',
    },
  },
  {
    id: 'zhipu-lite',
    name: '智谱 GLM（轻量）',
    freeNote: 'GLM-4.5-Flash 永久免费 · 延迟更低，适合高频试跑',
    permanentFree: true,
    corsOk: true,
    signupUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    config: {
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.5-flash',
    },
  },
  {
    id: 'modelscope',
    name: '魔搭 ModelScope',
    freeNote: '每日 2000 次免费调用 · 需绑定阿里云账号实名',
    permanentFree: false,
    corsOk: true,
    signupUrl: 'https://www.modelscope.cn/my/myaccesstoken',
    config: {
      baseUrl: 'https://api-inference.modelscope.cn/v1',
      model: 'Qwen/Qwen3-8B',
    },
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    freeNote: '注册赠 2000 万 token · 9B 以下小模型永久免费',
    permanentFree: false,
    corsOk: true,
    signupUrl: 'https://cloud.siliconflow.cn/account/ak',
    config: {
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'Qwen/Qwen3-8B',
    },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    freeNote: '16 个 :free 后缀模型免费用 · 有每日次数上限',
    permanentFree: false,
    corsOk: true,
    signupUrl: 'https://openrouter.ai/keys',
    config: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'qwen/qwen3.8-27b:free',
    },
  },
  {
    id: 'dashscope',
    name: '阿里百炼',
    freeNote: '新用户赠千万级 token · 超期后按量付费',
    permanentFree: false,
    corsOk: true,
    signupUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    config: {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
    },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    freeNote: '注册赠额度 · 用完后按量付费，单价极低',
    permanentFree: false,
    corsOk: true,
    signupUrl: 'https://platform.deepseek.com/api_keys',
    config: {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    },
  },
]

/** 判断当前配置命中了哪个预设，用于高亮 */
export function matchPreset(llm: LLMConfig): string | null {
  const hit = PROVIDER_PRESETS.find(
    (p) => p.config.baseUrl === llm.baseUrl && p.config.model === llm.model,
  )
  return hit?.id ?? null
}
