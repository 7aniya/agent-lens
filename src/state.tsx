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

    case 'run_end':
      return { ...state, status: event.status, endedAt: event.endedAt }

    case 'error':
      return {
        ...state,
        status: 'error',
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
      }

    case 'patch_settings':
      return { ...state, settings: { ...state.settings, ...action.settings } }

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
        },
      )

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
