import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../state'
import { runAgent } from '../agent/runtime'
import type { AgentEvent } from '../agent/types'

export function useAgentRun() {
  const { state, dispatch } = useStore()
  const abortRef = useRef<AbortController | null>(null)
  const eventsRef = useRef<AgentEvent[]>([])
  const stateRef = useRef(state)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  // 运行中的耗时计时器
  useEffect(() => {
    if (state.status !== 'running' || state.startedAt === null) return
    const tick = () => setElapsed(Date.now() - (state.startedAt ?? Date.now()))
    tick()
    const timer = window.setInterval(tick, 100)
    return () => window.clearInterval(timer)
  }, [state.status, state.startedAt])

  const start = useCallback(
    async (goal: string) => {
      const trimmed = goal.trim()
      if (!trimmed) return

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      eventsRef.current = []

      const snapshot = stateRef.current
      dispatch({ type: 'patch_goal', goal: trimmed })

      try {
        for await (const event of runAgent(trimmed, {
          settings: snapshot.settings,
          docs: snapshot.docs,
          signal: controller.signal,
        })) {
          eventsRef.current.push(event)
          dispatch({ type: 'event', event })
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          dispatch({
            type: 'event',
            event: { type: 'error', message: (error as Error).message },
          })
        }
      } finally {
        abortRef.current = null
        // eventsRef 里已经存了完整事件序列，交给 reducer 归档
        dispatch({ type: 'save_record', events: eventsRef.current })
      }
    },
    [dispatch],
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  return { start, cancel, elapsed, isRunning: state.status === 'running' }
}
