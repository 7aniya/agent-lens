import { useStore } from '../state'

export function Header({
  onOpenSettings,
  onOpenHistory,
}: {
  onOpenSettings: () => void
  onOpenHistory: () => void
}) {
  const { state, dispatch } = useStore()
  const { mode, llm } = state.settings

  // 模式标识必须说清「实际会发生什么」：
  // 选了真实模型但没填 Key 时，界面如果还显示「真实模型」，
  // 用户就会以为切换没生效——这正是之前被当成 bug 的地方。
  const keyMissing = mode === 'live' && !llm.apiKey.trim()
  const chipClass = keyMissing ? 'mode-warn' : mode === 'live' ? 'mode-live' : 'mode-mock'
  const chipText = keyMissing
    ? '缺 Key · 实际跑 Mock'
    : mode === 'live'
      ? `真实模型 · ${llm.model || '未填模型名'}`
      : 'Mock 离线模式'

  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <span className="brand-ring" />
          <span className="brand-core" />
        </span>
        <span className="brand-text">
          <span className="brand-name">AgentLens</span>
          <span className="brand-sub">AI Agent 执行过程可视化控制台</span>
        </span>
      </div>

      <div className="header-actions">
        <button
          type="button"
          className={`mode-chip ${chipClass}`}
          onClick={onOpenSettings}
          title={
            keyMissing
              ? '已选「真实模型」但未填 API Key，运行时会自动回退到 Mock。点击前往设置。'
              : mode === 'live'
                ? `将调用 ${llm.baseUrl} 的 ${llm.model}`
                : 'Mock 模式完全离线，不需要 API Key'
          }
        >
          <span className="mode-dot" aria-hidden />
          {chipText}
          {keyMissing && <span className="mode-chip-cta">去填写</span>}
        </button>

        <button type="button" className="btn btn-ghost" onClick={onOpenHistory}>
          历史运行
          {state.records.length > 0 && <span className="btn-count">{state.records.length}</span>}
        </button>

        <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>
          设置
        </button>

        <button
          type="button"
          className="btn btn-icon"
          onClick={() => dispatch({ type: 'toggle_theme' })}
          title={state.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          aria-label="切换主题"
        >
          {state.theme === 'dark' ? (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="4.2" />
              <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
    </header>
  )
}
