import { useState } from 'react'
import type { ToolCall } from '../agent/types'

const STATUS_LABEL: Record<ToolCall['status'], string> = {
  running: '执行中',
  done: '完成',
  error: '失败',
}

function formatDuration(call: ToolCall): string {
  if (!call.endedAt) return '—'
  const ms = call.endedAt - call.startedAt
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`
}

export function ToolCallCard({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const hasArgs = Object.keys(call.args).length > 0

  return (
    <div className={`tool-card tool-${call.status}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={`tool-dot tool-dot-${call.status}`} aria-hidden />
        <span className="tool-name">{call.name}</span>
        <span className={`tool-status tool-status-${call.status}`}>
          {STATUS_LABEL[call.status]}
        </span>
        <span className="tool-meta">{formatDuration(call)}</span>
        <span className={`tool-caret ${expanded ? 'open' : ''}`} aria-hidden />
      </button>

      {expanded && (
        <div className="tool-body">
          {hasArgs && (
            <div className="tool-section">
              <div className="tool-section-label">入参</div>
              <pre className="code-block">
                {JSON.stringify(call.args, null, 2)}
              </pre>
            </div>
          )}
          <div className="tool-section">
            <div className="tool-section-label">
              {call.status === 'error' ? '错误' : '返回'}
              {call.status === 'running' && <span className="pulse" aria-hidden />}
            </div>
            <pre className="code-block">
              {call.status === 'running'
                ? '执行中…'
                : call.error ?? call.result ?? '（无返回内容）'}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
