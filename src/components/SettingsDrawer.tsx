import { useMemo, useRef, useState } from 'react'
import { useStore } from '../state'
import { AVAILABLE_TOOLS } from '../agent/runtime'
import { BUILTIN_CORPUS, type KnowledgeDoc } from '../agent/corpus'
import { buildRuntimeIndex } from '../agent/runtime'

const SPEEDS = [1, 2, 4]

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore()
  const { settings, docs } = state
  const fileRef = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const stats = useMemo(() => buildRuntimeIndex(docs), [docs])

  const updateLLM = (patch: Partial<typeof settings.llm>) => {
    dispatch({ type: 'patch_settings', settings: { llm: { ...settings.llm, ...patch } } })
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const accepted: KnowledgeDoc[] = []
    for (const file of Array.from(files)) {
      if (!/\.(txt|md|markdown|csv|json)$/i.test(file.name)) {
        setNotice(`已跳过 ${file.name}：仅支持 txt / md / csv / json`)
        continue
      }
      const text = await file.text()
      accepted.push({
        id: `upload-${Date.now()}-${accepted.length}`,
        title: file.name.replace(/\.[^.]+$/, ''),
        source: '用户上传',
        content: text,
      })
    }
    if (accepted.length > 0) {
      dispatch({ type: 'set_docs', docs: [...docs, ...accepted] })
      setNotice(`已导入 ${accepted.length} 个文档，检索索引已重建`)
    }
  }

  return (
    <div className="drawer-mask" onClick={onClose} role="presentation">
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>设置</h2>
          <button type="button" className="btn btn-icon" onClick={onClose} aria-label="关闭">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="drawer-body">
          <section className="drawer-section">
            <h3>运行模式</h3>
            <div className="segmented">
              {(['mock', 'live'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`segment ${settings.mode === mode ? 'is-on' : ''}`}
                  onClick={() => dispatch({ type: 'patch_settings', settings: { mode } })}
                >
                  {mode === 'mock' ? 'Mock 离线' : '真实模型'}
                </button>
              ))}
            </div>
            <p className="field-hint">
              Mock 模式完全离线、结果可复现，调用的是真实工具实现，适合演示与自测；
              真实模型模式需要填写 OpenAI 兼容接口的 Base URL 与 API Key。
            </p>
          </section>

          <section className="drawer-section">
            <h3>模型配置</h3>
            <label className="field">
              <span className="field-label">Base URL</span>
              <input
                className="input"
                value={settings.llm.baseUrl}
                onChange={(e) => updateLLM({ baseUrl: e.target.value })}
                placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span className="field-label">API Key</span>
              <input
                className="input"
                type="password"
                value={settings.llm.apiKey}
                onChange={(e) => updateLLM({ apiKey: e.target.value })}
                placeholder="sk-..."
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span className="field-label">模型名</span>
              <input
                className="input"
                value={settings.llm.model}
                onChange={(e) => updateLLM({ model: e.target.value })}
                placeholder="qwen-plus"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span className="field-label">
                Temperature <b>{settings.llm.temperature.toFixed(1)}</b>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={settings.llm.temperature}
                onChange={(e) => updateLLM({ temperature: Number(e.target.value) })}
              />
            </label>
            <p className="field-hint">
              API Key 只保存在浏览器 localStorage，不会上传到任何服务器。
              若所调用服务未开启 CORS，可在 Vercel 部署后使用仓库内的 <code>api/llm-proxy.ts</code> 代理。
            </p>
          </section>

          <section className="drawer-section">
            <h3>演示速度</h3>
            <div className="segmented">
              {SPEEDS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  className={`segment ${settings.speed === speed ? 'is-on' : ''}`}
                  onClick={() => dispatch({ type: 'patch_settings', settings: { speed } })}
                >
                  {speed}x
                </button>
              ))}
            </div>
            <p className="field-hint">仅影响 Mock 模式的流式速度，便于录制演示视频。</p>
          </section>

          <section className="drawer-section">
            <h3>
              知识库
              <span className="section-meta">
                {docs.length} 篇 / {stats.chunkCount} 个切片
              </span>
            </h3>
            <ul className="doc-list">
              {docs.map((doc) => (
                <li key={doc.id} className="doc-item">
                  <span className="doc-title">{doc.title}</span>
                  <span className="doc-source">{doc.source}</span>
                </li>
              ))}
            </ul>
            <div className="drawer-actions">
              <button
                type="button"
                className="btn btn-soft"
                onClick={() => fileRef.current?.click()}
              >
                导入文档
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  dispatch({ type: 'set_docs', docs: BUILTIN_CORPUS })
                  setNotice('已恢复为内置知识库')
                }}
              >
                恢复内置
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".txt,.md,.markdown,.csv,.json"
              hidden
              onChange={(e) => {
                void handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
            {notice && <p className="notice">{notice}</p>}
          </section>

          <section className="drawer-section">
            <h3>
              已注册工具
              <span className="section-meta">{AVAILABLE_TOOLS.length} 个</span>
            </h3>
            <ul className="tool-list">
              {AVAILABLE_TOOLS.map((tool) => (
                <li key={tool.name} className="tool-list-item">
                  <code className="tool-list-name">{tool.name}</code>
                  <p className="tool-list-desc">{tool.description}</p>
                </li>
              ))}
            </ul>
            <p className="field-hint">
              新增工具只需在 <code>src/agent/tools.ts</code> 实现并注册，
              Agent 运行时与界面无需任何改动。
            </p>
          </section>
        </div>
      </aside>
    </div>
  )
}
