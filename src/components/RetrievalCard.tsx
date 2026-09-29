import type { RetrievalHit } from '../agent/types'

/**
 * RAG 检索结果卡片
 *
 * 把「查询 → 命中的切片 → 相关度分数」完整摊开，
 * 让检索这一环不再是黑盒。这是排查 RAG 问题最常用的视图。
 */
export function RetrievalCard({
  query,
  hits,
}: {
  query: string
  hits: RetrievalHit[]
}) {
  return (
    <div className="retrieval-card">
      <div className="retrieval-head">
        <span className="badge badge-blue">RAG 检索</span>
        <span className="retrieval-query">“{query}”</span>
        <span className="retrieval-count">{hits.length} 条命中</span>
      </div>
      <ul className="retrieval-list">
        {hits.map((hit, index) => (
          <li key={hit.chunkId} className="retrieval-item">
            <div className="retrieval-item-head">
              <span className="retrieval-rank">{index + 1}</span>
              <span className="retrieval-doc">{hit.docTitle}</span>
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
            <div className="retrieval-chunk-id">{hit.chunkId}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
