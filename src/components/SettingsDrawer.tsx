import { useMemo, useRef, useState } from 'react'
import { useStore } from '../state'
import { AVAILABLE_TOOLS } from '../agent/runtime'
import { BUILTIN_CORPUS, type KnowledgeDoc } from '../agent/corpus'
import { buildRuntimeIndex } from '../agent/runtime'
import { PROVIDER_PRESETS, matchPreset } from '../agent/providers'
import {
  probeConnection,
  inspectApiKey,
  hasApiKey,
  isServerManaged,
  type ProbeResult,
} from '../agent/llm'
import type { RunMode } from '../agent/types'

const SPEEDS = [1, 2, 4]

/** 「改为自填 Key」时回填的默认服务：永久免费且支持工具调用 */
const SELF_HOSTED_DEFAULT = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-4.7-flash',
}

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore()
  const { settings, docs } = state
  const fileRef = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * 模型配置区是否展开。
   * Mock 模式下这份配置完全不生效（不发任何网络请求），
   * 若与真实模型模式展示得一模一样，用户会以为「切换模式没区别」。
   * 因此默认跟随模式：切到真实模型自动展开，切回 Mock 自动收起。
   */
  const [showLLMConfig, setShowLLMConfig] = useState(settings.mode === 'live')

  const stats = useMemo(() => buildRuntimeIndex(docs), [docs])
  const activePreset = matchPreset(settings.llm)

  /**
   * 是否处于服务端托管模式（Base URL 指向同源代理）。
   * 托管时密钥在服务端，前端的 Key 输入框没有意义，
   * 展示它只会让人以为「还差一步没配好」。
   */
  const managed = isServerManaged(settings.llm)

  /**
   * Key 自检：把用户填进去的字符串原样摊开（长度 + 首尾片段）。
   * 输入框是 password 类型，填错了根本看不出来，
   * 而 401 的绝大多数原因就是「复制不全 / 混进了空格 / 拿错平台」。
   */
  const keyNotes = useMemo(
    () => (hasApiKey(settings.llm) ? inspectApiKey(settings.llm.apiKey, settings.llm.baseUrl) : []),
    [settings.llm],
  )

  const switchMode = (mode: RunMode) => {
    dispatch({ type: 'patch_settings', settings: { mode } })
    setShowLLMConfig(mode === 'live')
  }

  // 连接自检：把「配置能不能用」和「配置错在哪」分开，
  // 用户不用跑整个 Agent 就能定位问题。
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<ProbeResult | null>(null)

  const runProbe = async () => {
    setProbing(true)
    setProbe(null)
    const result = await probeConnection(settings.llm)
    setProbe(result)
    setProbing(false)
  }

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
                  onClick={() => switchMode(mode)}
                >
                  {mode === 'mock' ? 'Mock 离线' : '真实模型'}
                </button>
              ))}
            </div>
            <p className="field-hint">
              <b>Mock 离线</b>：内置确定性规划器驱动，规划、工具调用、图表全部在浏览器内完成，
              不发任何网络请求，结果可复现。检索走真实的混合检索实现，
              所以返回的相关度分数与命中切片都是真实数据。
              <br />
              <b>真实模型</b>：由大模型自主拆解任务、决定调用哪个工具。
              {managed
                ? '当前由服务端出密钥，无需填写任何配置。'
                : '需要下方配置 OpenAI 兼容接口的 Base URL 与 API Key。'}
            </p>
            {settings.mode === 'live' && !hasApiKey(settings.llm) && (
              <p className="inline-warn">
                当前 <b>API Key 为空</b>，运行时会自动回退到 Mock 模式，
                所以结果会和 Mock 模式下完全一致——这不是切换失效。
                在下面的预设里选一个填上 Key，才会真正调用模型。
              </p>
            )}
          </section>

          <section className="drawer-section">
            <h3>
              模型配置
              <span className="section-meta">
                {settings.mode === 'mock' ? 'Mock 模式不生效' : managed ? '服务端托管' : 'OpenAI 兼容'}
              </span>
            </h3>

            {settings.mode === 'mock' && !showLLMConfig ? (
              <div className="config-off">
                <p>
                  当前是 <b>Mock 离线模式</b>，模型配置<b>不生效</b>：规划、工具调用全部在浏览器内完成，
                  不会调用任何外部接口，也不需要 API Key。
                </p>
                <div className="drawer-actions">
                  <button
                    type="button"
                    className="btn btn-soft btn-sm"
                    onClick={() => switchMode('live')}
                  >
                    切换到真实模型并配置
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setShowLLMConfig(true)}
                  >
                    先填好 Key
                  </button>
                </div>
              </div>
            ) : (
              <>
                {settings.mode === 'mock' && (
                  <p className="inline-note">
                    当前仍是 <b>Mock 离线模式</b>，以下配置会保存但暂不生效；
                    切到「真实模型」后立即启用。
                  </p>
                )}

                {managed ? (
                  <div className="managed-note">
                    <p>
                      当前由 <b>服务端托管模型调用</b>：密钥保存在部署环境变量中，
                      浏览器不接触它，也不需要你填写——打开页面即可直接对话。
                    </p>
                    <dl className="managed-grid">
                      <dt>接口地址</dt>
                      <dd>
                        <code>{settings.llm.baseUrl}</code>
                        <span className="managed-tag">同源代理</span>
                      </dd>
                      <dt>模型名</dt>
                      <dd>
                        <code>{settings.llm.model}</code>
                        <span className="managed-tag">服务端设置 LLM_MODEL 时以服务端为准</span>
                      </dd>
                    </dl>
                  </div>
                ) : (
                  <>
                    <div className="preset-grid">
                      {PROVIDER_PRESETS.map((preset) => {
                        const active = activePreset === preset.id
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            className={`preset-card ${active ? 'is-on' : ''}`}
                            onClick={() =>
                              updateLLM({
                                baseUrl: preset.config.baseUrl,
                                model: preset.config.model,
                              })
                            }
                          >
                            <span className="preset-name">
                              {preset.name}
                              {preset.permanentFree && <em className="preset-tag">永久免费</em>}
                            </span>
                            <span className="preset-note">{preset.freeNote}</span>
                          </button>
                        )
                      })}
                    </div>

                    <p className="field-hint">
                      {activePreset
                        ? (() => {
                            const p = PROVIDER_PRESETS.find((x) => x.id === activePreset)!
                            return (
                              <>
                                已选中「{p.name}」。申请 Key：
                                <a href={p.signupUrl} target="_blank" rel="noreferrer">
                                  {p.signupUrl}
                                </a>
                                {p.corsOk ? '（实测支持浏览器直连）' : '（需服务端代理）'}
                              </>
                            )
                          })()
                        : '未匹配到预设，当前为自定义配置。点上方任意卡片可一键填入。'}{' '}
                      Key 只存在浏览器 localStorage，不会上传。
                    </p>

                    <label className="field">
                      <span className="field-label">Base URL</span>
                      <input
                        className="input"
                        value={settings.llm.baseUrl}
                        onChange={(e) => updateLLM({ baseUrl: e.target.value })}
                        placeholder="https://open.bigmodel.cn/api/paas/v4"
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
                    {keyNotes.length > 0 && (
                      <ul className="key-check">
                        {keyNotes.map((note) => (
                          <li
                            key={note.text}
                            className={note.level === 'info' ? 'is-info' : 'is-warn'}
                          >
                            {note.text}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}

                <label className="field">
                  <span className="field-label">模型名</span>
                  <input
                    className="input"
                    value={settings.llm.model}
                    onChange={(e) => updateLLM({ model: e.target.value })}
                    placeholder="glm-4.7-flash"
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
                <div className="probe-box">
                  <div className="probe-head">
                    <button
                      type="button"
                      className="btn btn-soft btn-sm"
                      onClick={() => void runProbe()}
                      disabled={probing || !hasApiKey(settings.llm)}
                    >
                      {probing ? '测试中…' : '测试连接'}
                    </button>
                    {probe && (
                      <span className={`probe-badge ${probe.ok ? 'is-ok' : 'is-bad'}`}>
                        {probe.ok
                          ? `连接正常 · ${probe.latencyMs}ms`
                          : `连接失败 · ${probe.latencyMs}ms`}
                      </span>
                    )}
                    {!hasApiKey(settings.llm) && (
                      <span className="probe-note">填入 API Key 后可测试</span>
                    )}
                  </div>

                  {probe?.ok && (
                    <p className="field-hint">
                      接口 {probe.endpoint}；服务端回显模型 <b>{probe.echoModel || '（未返回）'}</b>；
                      回复「{probe.reply || '（空）'}」。
                      {probe.echoModel && probe.echoModel !== probe.model && (
                        <>
                          {' '}
                          注意：回显模型与填写的模型名不一致，可能是服务端做了别名映射或路由。
                        </>
                      )}
                    </p>
                  )}
                  {probe && !probe.ok && <pre className="error-detail">{probe.error}</pre>}
                </div>

                {managed && (
                  <div className="drawer-actions">
                    <button
                      type="button"
                      className="btn btn-soft btn-sm"
                      onClick={() =>
                        updateLLM({ ...SELF_HOSTED_DEFAULT, apiKey: '' })
                      }
                    >
                      改为自填 API Key
                    </button>
                  </div>
                )}

                <p className="field-hint">
                  {managed
                    ? '想看看换成别的模型会怎样？可以改为自填 Key，直连任意 OpenAI 兼容接口，配置只保存在本机浏览器。'
                    : '以上服务的跨域支持均为实测结果。若换成未开放 CORS 的接口（例如 z.ai 国际站），会出现浏览器拦截，此时可部署到 Vercel 后启用仓库内的 api/llm-proxy.ts，把 Key 放到服务端环境变量里。'}
                </p>
              </>
            )}
          </section>

          <section className="drawer-section">
            <h3>演示速度</h3>
            <div className={`segmented ${settings.mode === 'live' ? 'is-off' : ''}`}>
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
            <p className="field-hint">
              {settings.mode === 'live'
                ? '当前是真实模型模式，流式速度由服务端决定，此项不生效。'
                : '仅影响 Mock 模式的流式速度，便于录制演示视频。'}
            </p>
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
            <p className="field-hint">
              内置语料的向量在构建期就已算好并随发布产物提供，所以语义检索不额外消耗额度；
              导入自己的文档时才会实时编码。
            </p>
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
