import type { RetrievalChannel, RetrievalHit, RetrievalTrace } from '../agent/types'

/**
 * RAG 检索结果卡片
 *
 * 把「查询 → 两个通道各自召回了什么 → 融合后留下什么」完整摊开，
 * 让检索这一环不再是黑盒。这是排查 RAG 问题最常用的视图。
 *
 * 为什么要把两个通道拆开展示，而不是只给融合后的排名？
 * 因为「答错了」这个现象无法反推原因：
 * 如果只看到融合结果，你分不清是词汇通道漏召、语义通道跑偏，还是两者都对但融合把它们排错了。
 * 把过程摊开后，这三类问题一眼可分 —— 这正是这个项目存在的理由。
 */

const CHANNEL_LABEL: Record<RetrievalChannel, string> = {
  bm25: '词汇',
  vector: '语义',
}

function ChannelTags({ channels }: { channels: RetrievalChannel[] }) {
  if (!channels || channels.length === 0) return null
  const both = channels.length > 1
  return (
    <span className={`channel-tags${both ? ' is-both' : ''}`} title={
      both ? '两个通道都召回了这条，词汇信号与语义信号互相印证' : '仅被单通道召回'
    }>
      {channels.map((channel) => (
        <span key={channel} className={`channel-tag channel-tag-${channel}`}>
          {CHANNEL_LABEL[channel]}
        </span>
      ))}
    </span>
  )
}

/** 单条命中在两个通道里的原始分数，用于回答「谁贡献了这条」 */
function PerChannelScores({ hit }: { hit: RetrievalHit }) {
  const parts: string[] = []
  if (typeof hit.bm25Score === 'number') parts.push(`词汇 ${(hit.bm25Score * 100).toFixed(0)}%`)
  if (typeof hit.vectorScore === 'number') parts.push(`语义 ${(hit.vectorScore * 100).toFixed(0)}%`)
  if (parts.length === 0) return null
  return <span className="retrieval-per-channel">{parts.join(' · ')}</span>
}

export function RetrievalCard({
  query,
  hits,
  trace,
}: {
  query: string
  hits: RetrievalHit[]
  trace?: RetrievalTrace
}) {
  const fused = trace?.fusion === 'rrf'
  const vectorHits = trace?.vector ?? null
  const degraded = trace != null && trace.vectorStatus !== 'ok'

  return (
    <div className="retrieval-card">
      <div className="retrieval-head">
        <span className="badge badge-blue">{fused ? 'RAG 混合检索' : 'RAG 检索'}</span>
        <span className="retrieval-query">“{query}”</span>
        <span className="retrieval-count">{hits.length} 条命中</span>
      </div>

      {trace && (
        <div className="retrieval-meta">
          <span className="retrieval-meta-item">
            融合策略：{fused ? 'RRF 倒数排名融合' : '仅词汇通道'}
          </span>
          <span className="retrieval-meta-item">词汇通道召回 {trace.bm25.length} 条</span>
          <span className="retrieval-meta-item">
            语义通道召回 {vectorHits ? `${vectorHits.length} 条` : '未参与'}
          </span>
          {typeof trace.vectorLatencyMs === 'number' && (
            <span className="retrieval-meta-item">语义通道耗时 {trace.vectorLatencyMs}ms</span>
          )}
        </div>
      )}

      {trace?.note && (
        <p className={`retrieval-note${degraded ? ' is-warn' : ''}`}>{trace.note}</p>
      )}

      {hits.length === 0 ? (
        <p className="retrieval-empty">
          没有任何切片命中。可以换一种问法，或确认知识库是否已收录该主题。
        </p>
      ) : (
        <ul className="retrieval-list">
          {hits.map((hit, index) => (
            <li key={hit.chunkId} className="retrieval-item">
              <div className="retrieval-item-head">
                <span className="retrieval-rank">{index + 1}</span>
                <span className="retrieval-doc">{hit.docTitle}</span>
                <ChannelTags channels={hit.channels} />
                <span className="retrieval-score">
                  <span className="score-bar" aria-hidden>
                    <span
                      className="score-fill"
                      style={{ width: `${Math.max(6, hit.score * 100)}%` }}
                    />
                  </span>
                  {(hit.score * 100).toFixed(0)}%
                </span>
              </div>
              <p className="retrieval-snippet">{hit.snippet}</p>
              <div className="retrieval-foot">
                <span className="retrieval-chunk-id">{hit.chunkId}</span>
                <PerChannelScores hit={hit} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {trace && trace.bm25.length > 0 && vectorHits && vectorHits.length > 0 && (
        <details className="retrieval-channels">
          <summary>展开两个通道各自的原始召回顺序</summary>
          <div className="retrieval-channel-grid">
            <div className="retrieval-channel-col">
              <h4>词汇通道 · BM25</h4>
              <ol>
                {trace.bm25.map((hit) => (
                  <li key={hit.chunkId}>
                    <span className="retrieval-channel-doc">{hit.docTitle}</span>
                    <span className="retrieval-channel-score">
                      {(hit.score * 100).toFixed(0)}%
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="retrieval-channel-col">
              <h4>语义通道 · 向量余弦</h4>
              <ol>
                {vectorHits.map((hit) => (
                  <li key={hit.chunkId}>
                    <span className="retrieval-channel-doc">{hit.docTitle}</span>
                    <span className="retrieval-channel-score">
                      {(hit.score * 100).toFixed(0)}%
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <p className="retrieval-channel-hint">
            两个通道顺序不一致是正常的：词汇通道对专有名词敏感，语义通道对同义改写敏感。
            融合后同时被两通道命中的条目会排到前面，因为两个独立信号同时指向它，可信度更高。
          </p>
        </details>
      )}
    </div>
  )
}
