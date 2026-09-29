import { useState } from 'react'
import { StoreProvider, useStore } from './state'
import { Header } from './components/Header'
import { PlanPanel } from './components/PlanPanel'
import { StreamPanel } from './components/StreamPanel'
import { TracePanel } from './components/TracePanel'
import { GoalComposer } from './components/GoalComposer'
import { SettingsDrawer } from './components/SettingsDrawer'
import { RecordDeleteButton } from './components/RecordDeleteButton'

function HistoryDrawer({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore()
  const records = state.records

  return (
    <div className="drawer-mask" onClick={onClose} role="presentation">
      <aside className="drawer drawer-narrow" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>历史运行</h2>
          <button type="button" className="btn btn-icon" onClick={onClose} aria-label="关闭">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="drawer-body">
          <p className="field-hint">
            每次运行结束后会自动记录完整事件序列，点击可还原当时的执行现场，
            用于复盘 Agent 在哪一步出了问题。
          </p>
          {records.length === 0 ? (
            <p className="trace-empty">还没有历史记录，先运行一次吧。</p>
          ) : (
            <ul className="record-list record-list-lg">
              {records.map((record) => (
                <li key={record.id} className="record-row">
                  <button
                    type="button"
                    className="record-item"
                    onClick={() => {
                      dispatch({ type: 'load_record', record })
                      onClose()
                    }}
                  >
                    <span className="record-goal">{record.goal}</span>
                    <span className="record-meta">
                      {record.events.length} 个事件 · {record.mode === 'mock' ? 'Mock' : '真实模型'} ·{' '}
                      {new Date(record.startedAt).toLocaleString('zh-CN', {
                        hour12: false,
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </button>
                  <RecordDeleteButton id={record.id} goal={record.goal} />
                </li>
              ))}
            </ul>
          )}
          {records.length > 0 && (
            <div className="drawer-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => dispatch({ type: 'clear_records' })}
              >
                清空全部记录
              </button>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}

function FallbackBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { state } = useStore()
  if (!state.fallbackReason) return null

  return (
    <div className="fallback-banner" role="status">
      <span className="fallback-icon" aria-hidden>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 8.5v5" strokeLinecap="round" />
          <circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none" />
          <path d="M10.3 3.6 2.4 17.2A2 2 0 0 0 4.1 20.2h15.8a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="fallback-text">
        <strong>本次运行并未使用真实模型。</strong>
        <span>
          {state.fallbackReason}。你看到的规划、工具调用与回答全部来自本地 Mock
          运行时，所以和 Mock 模式下的结果一致——这是预期行为，不是切换失效。
        </span>
      </div>
      <button type="button" className="btn btn-primary btn-sm" onClick={onOpenSettings}>
        去填写 API Key
      </button>
    </div>
  )
}

function Shell() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  return (
    <div className="app">
      <Header
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHistory={() => setHistoryOpen(true)}
      />
      <FallbackBanner onOpenSettings={() => setSettingsOpen(true)} />
      <main className="app-grid">
        <PlanPanel />
        <StreamPanel />
        <TracePanel />
      </main>
      <GoalComposer />
      {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
      {historyOpen && <HistoryDrawer onClose={() => setHistoryOpen(false)} />}
    </div>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
