/**
 * Vercel Edge Runtime 环境变量声明
 *
 * api/ 目录由 Vercel 构建，不经过 vite，也没有 @types/node。
 * 这里手写最小声明而不是引入 @types/node：
 * 边缘运行时能用的 Node API 本来就只有 process.env 这一点，
 * 把整套 Node 类型拉进来反而会让人误以为可以用 fs / path。
 */
declare const process: {
  env: {
    /** LLM 对话代理 */
    LLM_BASE_URL?: string
    LLM_API_KEY?: string
    LLM_MODEL?: string
    /** Embedding 代理（缺省时回退到 DASHSCOPE_API_KEY / LLM_API_KEY） */
    EMBEDDING_BASE_URL?: string
    EMBEDDING_API_KEY?: string
    EMBEDDING_MODEL?: string
    EMBEDDING_DIM?: string
    /** 阿里百炼的通用密钥名 */
    DASHSCOPE_API_KEY?: string
    [key: string]: string | undefined
  }
}
