import type { GraphData, GraphEdge, GraphNode } from '../api'
import { FACTION_KIND_LABEL, UNASSIGNED_FACTION_ID, factionColor } from '../factions'

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

  /** 所属势力（主势力排首位；后端传播推断的归属会标注） */
  const factionsOf = (node: GraphNode) => {
    if (!graph) return []
    const ids = new Set(node.faction_ids)
    if (node.primary_faction_id) ids.add(node.primary_faction_id)
    return graph.factions
      .filter((f) => ids.has(f.faction_id))
      .sort((a, b) =>
        a.faction_id === node.primary_faction_id
          ? -1
          : b.faction_id === node.primary_faction_id
            ? 1
            : a.order - b.order,
      )
  }

  return (
    <aside className="side" id="detail-side">
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
          {(() => {
            const fs = factionsOf(selectedNode)
            if (!fs.length) return null
            return (
              <div className="faction-list">
                <span className="faction-list-title">势力归属</span>
                {fs.map((f) => (
                  <span
                    key={f.faction_id}
                    className="faction-chip"
                    style={{ borderColor: factionColor(f), color: factionColor(f) }}
                  >
                    {f.name}
                    {f.faction_id !== UNASSIGNED_FACTION_ID && (
                      <em>{FACTION_KIND_LABEL[f.kind] ?? f.kind}</em>
                    )}
                    {f.faction_id === selectedNode.primary_faction_id &&
                      fs.length > 1 && <em>主</em>}
                    {f.needs_review.includes(selectedNode.person_id) && (
                      <em title="块内与任何同伴都无连线，归属可疑">待核</em>
                    )}
                  </span>
                ))}
                {selectedNode.faction_inferred && (
                  <span className="hint">
                    归属由邻居推断（原文未直接写明），可人工修正
                  </span>
                )}
              </div>
            )
          })()}
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