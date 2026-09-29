/**
 * 应用状态层
 *
 * 刻意不引入 Redux / Zustand：
 * AgentLens 的状态变化几乎全部来自单一来源（Agent 事件流），
 * useReducer 已经足够，且能让使用者一眼看懂数据怎么流动。
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react'
import type {
  AgentEvent,
  AppSettings,
  ChartSpec,
  ChatMessage,
  PlanNode,
  RetrievalHit,
  RunMode,
  RunRecord,
  RunUsage,
  ToolCall,
} from './agent/types'
import { DEFAULT_SETTINGS } from './agent/types'
import { BUILTIN_CORPUS, type KnowledgeDoc } from './agent/corpus'

export interface LogEntry {
  id: string
  level: 'info' | 'warn' | 'error'
  text: string
  at: number
}

/**
 * 主执行流的排序索引。
 * 消息、工具调用、检索结果、图表分别存在不同的数组里，
 * 但要按「真实发生顺序」交织渲染，所以额外维护一条有序的时间线。
 */
export interface TimelineItem {
  kind: 'message' | 'tool' | 'retrieval' | 'chart'
  id: string
}

export interface State {
  goal: string
  runId: string | null
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  startedAt: number | null
  endedAt: number | null
  nodes: PlanNode[]
  timeline: TimelineItem[]
  messages: ChatMessage[]
  toolCalls: ToolCall[]
  retrievals: { id: string; query: string; hits: RetrievalHit[] }[]
  charts: ChartSpec[]
  logs: LogEntry[]
  usage: RunUsage | null
  records: RunRecord[]
  settings: AppSettings
  docs: KnowledgeDoc[]
  theme: 'dark' | 'light'
  selectedNodeId: string | null
  /**
   * 本次运行**实际**使用的模式（来自 run_start 事件），而不是设置里选的那个。
   * 两者可能不一致：选了真实模型但没填 Key 会回退到 mock。
   * 界面上的模式标识必须以这个为准，否则会误导用户。
   */
  activeMode: RunMode | null
  /** 发生回退时的说明文案，为空表示没有回退 */
  fallbackReason: string | null
  /**
   * 本次运行失败的完整说明（多行，含针对性排查建议）。
   * 失败时如果只往运行日志里塞一行字，用户很难注意到，也无从下手排查，
   * 因此单独存一份供主区域的错误卡片展示。
   */
  errorMessage: string | null
}

export type Action =
  | { type: 'event'; event: AgentEvent }
  | { type: 'patch_goal'; goal: string }
  | { type: 'reset_run' }
  | { type: 'patch_settings'; settings: Partial<AppSettings> }
  | { type: 'set_docs'; docs: KnowledgeDoc[] }
  | { type: 'toggle_theme' }
  | { type: 'select_node'; nodeId: string | null }
  | { type: 'save_record'; events: AgentEvent[] }
  | { type: 'load_record'; record: RunRecord }
  | { type: 'delete_record'; id: string }
  | { type: 'clear_records' }

const STORAGE_KEY = 'agentlens.state.v1'

function loadPersisted(): Pick<State, 'settings' | 'docs' | 'theme'> {
  const fallback = {
    settings: DEFAULT_SETTINGS,
    docs: BUILTIN_CORPUS,
    theme: 'dark' as const,
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<State>
    return {
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      docs: parsed.docs && parsed.docs.length > 0 ? parsed.docs : BUILTIN_CORPUS,
      theme: parsed.theme === 'light' ? 'light' : 'dark',
    }
  } catch {
    return fallback
  }
}

export function createInitialState(): State {
  const persisted = loadPersisted()
  return {
    goal: '',
    runId: null,
    status: 'idle',
    startedAt: null,
    endedAt: null,
    nodes: [],
    timeline: [],
    messages: [],
    toolCalls: [],
    retrievals: [],
    charts: [],
    logs: [],
    usage: null,
    records: [],
    selectedNodeId: null,
    activeMode: null,
    fallbackReason: null,
    errorMessage: null,
    ...persisted,
  }
}

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}

function reduceEvent(state: State, event: AgentEvent): State {
  switch (event.type) {
    case 'run_start':
      return {
        ...state,
        runId: event.runId,
        goal: event.goal,
        status: 'running',
        startedAt: event.startedAt,
        endedAt: null,
        activeMode: event.mode,
        fallbackReason: null,
        errorMessage: null,
        nodes: [],
        timeline: [],
        messages: [],
        toolCalls: [],
        retrievals: [],
        charts: [],
        logs: [],
        usage: null,
        selectedNodeId: null,
      }

    case 'plan':
      return { ...state, nodes: event.nodes.map((n) => ({ ...n })) }

    case 'node_status':
      return {
        ...state,
        nodes: state.nodes.map((n) =>
          n.id === event.nodeId
            ? {
                ...n,
                status: event.status,
                startedAt: event.status === 'running' ? event.at : n.startedAt,
                endedAt:
                  event.status === 'done' || event.status === 'error' || event.status === 'skipped'
                    ? event.at
                    : n.endedAt,
              }
            : n,
        ),
      }

    case 'message_start':
      return {
        ...state,
        timeline: [...state.timeline, { kind: 'message', id: event.messageId }],
        messages: [
          ...state.messages,
          {
            id: event.messageId,
            role: event.role,
            content: '',
            createdAt: Date.now(),
            streaming: true,
            kind: event.kind,
          },
        ],
      }

    case 'message_delta':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === event.messageId ? { ...m, content: m.content + event.delta } : m,
        ),
      }

    case 'message_end':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === event.messageId ? { ...m, streaming: false } : m,
        ),
      }

    case 'tool_call':
      return {
        ...state,
        timeline: [...state.timeline, { kind: 'tool', id: event.call.id }],
        toolCalls: [...state.toolCalls, event.call],
      }

    case 'tool_result':
      return {
        ...state,
        toolCalls: state.toolCalls.map((c) =>
          c.id === event.callId
            ? { ...c, status: 'done', result: event.result, endedAt: event.endedAt }
            : c,
        ),
      }

    case 'tool_error':
      return {
        ...state,
        toolCalls: state.toolCalls.map((c) =>
          c.id === event.callId
            ? { ...c, status: 'error', error: event.error, endedAt: event.endedAt }
            : c,
        ),
      }

    case 'retrieval': {
      const id = nextId('ret')
      return {
        ...state,
        timeline: [...state.timeline, { kind: 'retrieval', id }],
        retrievals: [...state.retrievals, { id, query: event.query, hits: event.hits }],
      }
    }

    case 'chart':
      return {
        ...state,
        timeline: [...state.timeline, { kind: 'chart', id: event.spec.id }],
        charts: [...state.charts, event.spec],
      }

    case 'usage':
      return { ...state, usage: event.usage }

    case 'log':
      return {
        ...state,
        logs: [...state.logs, { id: nextId('log'), level: event.level, text: event.text, at: Date.now() }],
      }

    case 'mode_fallback':
      return { ...state, fallbackReason: event.reason }

    case 'run_end':
      return { ...state, status: event.status, endedAt: event.endedAt }

    case 'error':
      return {
        ...state,
        status: 'error',
        errorMessage: event.message,
        logs: [
          ...state.logs,
          { id: nextId('log'), level: 'error', text: event.message, at: Date.now() },
        ],
      }

    default:
      return state
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'event':
      return reduceEvent(state, action.event)

    case 'patch_goal':
      return { ...state, goal: action.goal }

    case 'reset_run':
      return {
        ...state,
        runId: null,
        status: 'idle',
        startedAt: null,
        endedAt: null,
        nodes: [],
        timeline: [],
        messages: [],
        toolCalls: [],
        retrievals: [],
        charts: [],
        logs: [],
        usage: null,
        selectedNodeId: null,
        activeMode: null,
        fallbackReason: null,
        errorMessage: null,
      }

    case 'patch_settings': {
      const settings = { ...state.settings, ...action.settings }
      return {
        ...state,
        settings,
        // 切回 Mock 或补上 Key 之后，回退提示就不再适用了
        fallbackReason:
          settings.mode === 'mock' || settings.llm.apiKey.trim() ? null : state.fallbackReason,
      }
    }

    case 'set_docs':
      return { ...state, docs: action.docs }

    case 'toggle_theme':
      return { ...state, theme: state.theme === 'dark' ? 'light' : 'dark' }

    case 'select_node':
      return { ...state, selectedNodeId: state.selectedNodeId === action.nodeId ? null : action.nodeId }

    case 'save_record': {
      if (!state.runId || state.startedAt === null) return state
      if (state.records.some((r) => r.id === state.runId)) return state
      const record: RunRecord = {
        id: state.runId,
        goal: state.goal,
        mode: state.settings.mode,
        startedAt: state.startedAt,
        endedAt: state.endedAt ?? Date.now(),
        status: state.status === 'idle' ? 'done' : state.status,
        events: action.events,
      }
      return { ...state, records: [record, ...state.records].slice(0, 12) }
    }

    case 'load_record':
      // 回放时会重新走一遍 run_start / mode_fallback，
      // 因此这里要把两者清空，避免沿用上一次的模式标识。
      return action.record.events.reduce<State>(
        (acc, ev) => reduceEvent(acc, ev),
        {
          ...state,
          status: 'idle',
          messages: [],
          nodes: [],
          timeline: [],
          toolCalls: [],
          retrievals: [],
          charts: [],
          logs: [],
          activeMode: null,
          fallbackReason: null,
          errorMessage: null,
        },
      )

    case 'delete_record':
      // 只从历史列表移除；若这条记录正被回放展示，当前视图保持不动。
      return { ...state, records: state.records.filter((r) => r.id !== action.id) }

    case 'clear_records':
      return { ...state, records: [] }

    default:
      return state
  }
}

interface StoreValue {
  state: State
  dispatch: Dispatch<Action>
}

const StoreContext = createContext<StoreValue | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState)

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme
  }, [state.theme])

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          settings: state.settings,
          docs: state.docs,
          theme: state.theme,
        }),
      )
    } catch {
      // 隐私模式下 localStorage 可能不可用，忽略即可
    }
  }, [state.settings, state.docs, state.theme])

  const value = useMemo(() => ({ state, dispatch }), [state])
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext)
  if (!value) throw new Error('useStore 必须在 StoreProvider 内部使用')
  return value
}

export type { KnowledgeDoc }
