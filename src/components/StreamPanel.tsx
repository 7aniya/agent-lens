import { useEffect, useRef } from 'react'
import { useStore } from '../state'
import { MarkdownView } from './MarkdownView'
import { ToolCallCard } from './ToolCallCard'
import { RetrievalCard } from './RetrievalCard'
import { ChartView } from './ChartView'

export function StreamPanel() {
  const { state } = useStore()
  const { timeline, messages, toolCalls, retrievals, charts, status } = state
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  // 只有用户停留在底部时才自动滚动，避免打断向上翻阅
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [timeline, messages])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const isEmpty = timeline.length === 0

  return (
    <section className="panel panel-center">
      <div className="panel-head">
        <h2>执行流</h2>
        {status === 'running' && (
          <span className="running-badge">
            <span className="running-dot" aria-hidden />
            运行中
          </span>
        )}
      </div>

      <div className="stream-scroll" ref={scrollRef} onScroll={handleScroll}>
        {isEmpty ? (
          <div className="empty-hint empty-center">
            <div className="empty-mark" aria-hidden />
            <p>执行流会实时展示 Agent 的推理过程、工具调用与最终回答。</p>
            <p className="empty-sub">选一个下方示例目标，或直接输入你自己的问题。</p>
          </div>
        ) : (
          timeline.map((item) => {
            if (item.kind === 'message') {
              const message = messages.find((m) => m.id === item.id)
              if (!message) return null
              const isThink = message.kind === 'think'
              return (
                <div
                  key={item.id}
                  className={`bubble ${isThink ? 'bubble-think' : 'bubble-answer'}`}
                >
                  <div className="bubble-head">
                    <span className={`badge ${isThink ? 'badge-muted' : 'badge-accent'}`}>
                      {isThink ? '推理' : '回答'}
                    </span>
                    {message.streaming && <span className="pulse" aria-hidden />}
                  </div>
                  {isThink ? (
                    <p className="think-text">{message.content || '…'}</p>
                  ) : (
                    <MarkdownView source={message.content} />
                  )}
                </div>
              )
            }

            if (item.kind === 'tool') {
              const call = toolCalls.find((c) => c.id === item.id)
              if (!call) return null
              return (
                <div key={item.id} className="row-indent">
                  <ToolCallCard call={call} />
                </div>
              )
            }

            if (item.kind === 'retrieval') {
              const retrieval = retrievals.find((r) => r.id === item.id)
              if (!retrieval) return null
              return (
                <div key={item.id} className="row-indent">
                  <RetrievalCard query={retrieval.query} hits={retrieval.hits} />
                </div>
              )
            }

            const chart = charts.find((c) => c.id === item.id)
            if (!chart) return null
            return (
              <div key={item.id} className="row-indent">
                <ChartView spec={chart} />
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
