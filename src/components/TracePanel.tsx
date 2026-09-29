import { useStore } from '../state'
import { RecordDeleteButton } from './RecordDeleteButton'

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function TracePanel() {
  const { state, dispatch } = useStore()
  const { toolCalls, retrievals, usage, logs, startedAt, endedAt, status, nodes } = state

  const validCalls = toolCalls.filter((c) => c.endedAt)
  const runDuration = startedAt ? (endedAt ?? Date.now()) - startedAt : 0
  const totalLatency = validCalls.reduce((sum, c) => sum + ((c.endedAt ?? 0) - c.startedAt), 0)
  const totalTokens = usage ? usage.promptTokens + usage.completionTokens : 0

  const spanStart = startedAt ?? Date.now()
  const spanEnd = Math.max(endedAt ?? Date.now(), spanStart + 1)

  return (
    <section className="panel panel-right">
      <div className="panel-head">
        <h2>可观测性</h2>
        {usage && <span className="panel-count">{totalTokens.toLocaleString()} tokens</span>}
      </div>

      <div className="metrics-grid">
        <div className="metric">
          <span className="metric-label">总耗时</span>
          <span className="metric-value">{runDuration ? formatMs(runDuration) : '—'}</span>
        </div>
        <div className="metric">
          <span className="metric-label">工具调用</span>
          <span className="metric-value">{toolCalls.length}</span>
        </div>
        <div className="metric">
          <span className="metric-label">RAG 检索</span>
          <span className="metric-value">{retrievals.length}</span>
        </div>
        <div className="metric">
          <span className="metric-label">工具总耗时</span>
          <span className="metric-value">{totalLatency ? formatMs(totalLatency) : '—'}</span>
        </div>
        <div className="metric">
          <span className="metric-label">输入 token</span>
          <span className="metric-value">{usage ? usage.promptTokens.toLocaleString() : '—'}</span>
        </div>
        <div className="metric">
          <span className="metric-label">输出 token</span>
          <span className="metric-value">{usage ? usage.completionTokens.toLocaleString() : '—'}</span>
        </div>
      </div>

      {validCalls.length > 0 && (
        <div className="trace-block">
          <div className="trace-block-title">工具调用时间线</div>
          <div className="gantt">
            {validCalls.map((call) => {
              const left = ((call.startedAt - spanStart) / (spanEnd - spanStart)) * 100
              const width = Math.max(
                1.5,
                (((call.endedAt ?? call.startedAt) - call.startedAt) / (spanEnd - spanStart)) * 100,
              )
              return (
                <div key={call.id} className="gantt-row">
                  <span className="gantt-label" title={call.name}>
                    {call.name}
                  </span>
                  <span className="gantt-track">
                    <span
                      className={`gantt-bar ${call.status === 'error' ? 'is-error' : ''}`}
                      style={{ left: `${Math.min(98, left)}%`, width: `${width}%` }}
                    />
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {nodes.length > 0 && (
        <div className="trace-block">
          <div className="trace-block-title">步骤耗时排行</div>
          <ul className="rank-list">
            {nodes
              .filter((n) => n.startedAt && n.endedAt)
              .map((n) => ({ id: n.id, title: n.title, ms: (n.endedAt ?? 0) - (n.startedAt ?? 0) }))
              .sort((a, b) => b.ms - a.ms)
              .slice(0, 5)
              .map((item) => (
                <li key={item.id} className="rank-item">
                  <span className="rank-title">{item.title}</span>
                  <span className="rank-value">{formatMs(item.ms)}</span>
                </li>
              ))}
          </ul>
        </div>
      )}

      <div className="trace-block trace-block-grow">
        <div className="trace-block-title">
          运行日志
          {status === 'running' && <span className="pulse" aria-hidden />}
        </div>
        {logs.length === 0 ? (
          <p className="trace-empty">暂无日志</p>
        ) : (
          <ul className="log-list">
            {logs.map((log) => (
              <li key={log.id} className={`log-item log-${log.level}`}>
                <span className="log-time">
                  {new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
                <span className="log-text">{log.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {state.records.length > 0 && (
        <div className="trace-block">
          <div className="trace-block-title">
            历史运行
            <button
              type="button"
              className="link-btn"
              onClick={() => dispatch({ type: 'clear_records' })}
            >
              清空
            </button>
          </div>
          <ul className="record-list">
            {state.records.slice(0, 5).map((record) => (
              <li key={record.id} className="record-row">
                <button
                  type="button"
                  className="record-item"
                  onClick={() => dispatch({ type: 'load_record', record })}
                >
                  <span className="record-goal">{record.goal}</span>
                  <span className="record-meta">
                    {record.mode === 'mock' ? 'Mock' : '真实模型'} ·{' '}
                    {formatMs((record.endedAt ?? record.startedAt) - record.startedAt)}
                  </span>
                </button>
                <RecordDeleteButton id={record.id} goal={record.goal} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
