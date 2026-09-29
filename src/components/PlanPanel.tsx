import { useStore } from '../state'
import type { PlanNode } from '../agent/types'

const STATUS_TEXT: Record<PlanNode['status'], string> = {
  pending: '待执行',
  running: '执行中',
  done: '已完成',
  error: '失败',
  skipped: '已跳过',
}

function duration(node: PlanNode): string | null {
  if (!node.startedAt || !node.endedAt) return null
  const ms = node.endedAt - node.startedAt
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`
}

export function PlanPanel() {
  const { state, dispatch } = useStore()
  const { nodes, goal, selectedNodeId, status } = state

  const doneCount = nodes.filter((n) => n.status === 'done').length
  const progress = nodes.length ? (doneCount / nodes.length) * 100 : 0

  return (
    <section className="panel panel-left">
      <div className="panel-head">
        <h2>任务规划</h2>
        {nodes.length > 0 && (
          <span className="panel-count">
            {doneCount}/{nodes.length}
          </span>
        )}
      </div>

      {nodes.length > 0 && (
        <div className="progress-track" aria-hidden>
          <div
            className={`progress-fill ${status === 'running' ? 'is-running' : ''}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {nodes.length === 0 ? (
        <div className="empty-hint">
          <p>输入一个目标并运行，Agent 会把任务拆解成步骤显示在这里。</p>
        </div>
      ) : (
        <>
          <div className="plan-goal">
            <span className="plan-goal-label">目标</span>
            <span className="plan-goal-text">{goal}</span>
          </div>
          <ol className="plan-list">
            {nodes.map((node, index) => {
              const active = node.id === selectedNodeId
              const time = duration(node)
              return (
                <li key={node.id} className={`plan-item plan-${node.status}`}>
                  <span className="plan-rail" aria-hidden>
                    {index < nodes.length - 1 && <span className="plan-line" />}
                    <span className={`plan-marker marker-${node.status}`}>
                      {node.status === 'done' ? (
                        <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M2 6.2l2.6 2.6L10 3.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : node.status === 'running' ? (
                        <span className="marker-spin" />
                      ) : (
                        <span className="marker-index">{index + 1}</span>
                      )}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={`plan-content ${active ? 'is-active' : ''}`}
                    onClick={() => dispatch({ type: 'select_node', nodeId: node.id })}
                  >
                    <span className="plan-title">{node.title}</span>
                    {node.detail && <span className="plan-detail">{node.detail}</span>}
                    <span className="plan-foot">
                      <span className={`plan-status status-${node.status}`}>
                        {STATUS_TEXT[node.status]}
                      </span>
                      {node.tool && <span className="plan-tool">{node.tool}</span>}
                      {time && <span className="plan-time">{time}</span>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </>
      )}
    </section>
  )
}
