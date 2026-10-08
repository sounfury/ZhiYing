/**
 * 人名册页签（只读）：当前图范围内的人物按出场章数排序，点一行即在图上聚焦此人并切到人物页签。
 * 人物由系统自动归并（PRD §5.3、§5.8），这里不提供改名、合并等人工整理入口。
 */
import { useMemo } from 'react'
import type { ChapterBrief, GraphData } from '../api'
import { PersonRow } from './PersonParts'
import { byAppearance } from './personUtils'

interface CastPanelProps {
  graph: GraphData | null
  chapters: ChapterBrief[]
  loading: boolean
  onFocusPerson: (personId: string) => void
}

export function CastPanel({ graph, chapters, loading, onFocusPerson }: CastPanelProps) {
  const people = useMemo(() => [...(graph?.nodes ?? [])].sort(byAppearance), [graph])

  if (!graph) {
    return <p className="side-empty">{loading ? '正在翻开人名册…' : '分析完成后，书里的人物会列在这里。'}</p>
  }
  if (!people.length) {
    return <p className="side-empty">当前范围里还没有人物。</p>
  }

  return (
    <div className="cast-panel">
      <p className="side-note">按出场章数排序 · 人物由系统自动归并，无需手动整理</p>
      <div className="person-list">
        {people.map((n) => (
          <PersonRow
            key={n.person_id}
            node={n}
            graph={graph}
            chapters={chapters}
            onPick={onFocusPerson}
          />
        ))}
      </div>
      {graph.filtered_count > 0 && (
        <details className="filtered-note">
          <summary>
            另有 {graph.filtered_count} 位路人未列出（出场章数低于阈值且无硬关系，可在图的筛选里调整）
          </summary>
          <p>{graph.filtered_persons.map((p) => p.name).join('、')}</p>
        </details>
      )}
    </div>
  )
}
