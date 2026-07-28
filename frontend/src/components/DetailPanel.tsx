import type { GraphData, GraphEdge, GraphNode } from '../api'

interface DetailPanelProps {
  graph: GraphData | null
  selectedNode: GraphNode | null
  selectedEdge: GraphEdge | null
  egoPersonId: string | null
  chapterLabel: (id: number | undefined) => string
  onSetEgo: (personId: string | null) => void
}

export function DetailPanel({
  graph,
  selectedNode,
  selectedEdge,
  egoPersonId,
  chapterLabel,
  onSetEgo,
}: DetailPanelProps) {
  const nameOf = (pid: string) =>
    graph?.nodes.find((n) => n.person_id === pid)?.name ?? pid

  return (
    <aside className="side">
      <h2>详情</h2>

      {!selectedNode && !selectedEdge && (
        <p className="hint">
          点击节点或边查看详情。拖动画布 / 滚轮缩放。
          在人物详情中可「只看与此人的关系」。
        </p>
      )}

      {selectedNode && (
        <div className="card">
          <h3>{selectedNode.name}</h3>
          <dl>
            <dt>id</dt>
            <dd>{selectedNode.person_id}</dd>
            <dt>重要度</dt>
            <dd>{selectedNode.importance}</dd>
            <dt>出场章数</dt>
            <dd>{selectedNode.appearance_count}</dd>
            <dt>别名</dt>
            <dd>{selectedNode.aliases.join('、') || '—'}</dd>
            <dt>简介</dt>
            <dd>{selectedNode.bio || '—'}</dd>
          </dl>
          <div className="detail-actions">
            {egoPersonId === selectedNode.person_id ? (
              <button
                type="button"
                className="btn"
                onClick={() => onSetEgo(null)}
              >
                回到全图
              </button>
            ) : (
              <button
                type="button"
                className="btn primary"
                onClick={() => onSetEgo(selectedNode.person_id)}
              >
                只看与此人的关系
              </button>
            )}
          </div>
        </div>
      )}

      {selectedEdge && (
        <div className="card">
          <h3>
            {nameOf(selectedEdge.person_a)} ↔ {nameOf(selectedEdge.person_b)}
          </h3>
          {selectedEdge.tags.map((t) => (
            <div key={t.type} className={`tag tier-${t.tier}`}>
              <div className="tag-head">
                <strong>{t.type}</strong>
                <span>
                  {t.tier}
                  {t.directed ? ' · 有向' : ''}
                  {t.suppressed ? ' · 已压制' : ''}
                </span>
              </div>
              <div className="tag-meta">
                分 {t.display_score.toFixed(1)} ·{' '}
                {t.chapter_ids.map((id) => chapterLabel(id)).join('、')}
              </div>
              {t.evidences.length > 0 && (
                <ul className="quotes">
                  {t.evidences.map((ev, i) => (
                    <li key={i}>
                      <span className="ch">{chapterLabel(ev.chapter_id)}</span>
                      {ev.quote || '（无原句）'}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {graph && graph.filtered_persons.length > 0 && (
        <div className="card muted">
          <h3>隐藏路人 ({graph.filtered_count})</h3>
          <p className="hint">
            {graph.filtered_persons.map((p) => p.name).join('、')}
          </p>
        </div>
      )}
    </aside>
  )
}