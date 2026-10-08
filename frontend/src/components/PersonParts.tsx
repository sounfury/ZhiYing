/** 侧栏共用的人物小部件：势力色头像、线型符号、出场章节缩略条、人物列表行。 */
import type { ChapterBrief, GraphData, GraphNode, Hardness } from '../api'
import { IMPORTANCE_LABEL } from '../labels'
import { nodeColor } from './personUtils'

/** 线型符号：硬实线 / 中虚线 / 软点线，与图上一致 */
export function HardnessSymbol({ hardness }: { hardness: Hardness }) {
  return <span className={`hsym ${hardness}`} aria-hidden="true" />
}

export function Avatar({ name, color, size = 'lg' }: { name: string; color: string; size?: 'lg' | 'sm' }) {
  return (
    <span
      className={`avatar${size === 'sm' ? ' mini' : ''}`}
      style={{
        color,
        borderColor: color,
        background: `color-mix(in srgb, ${color} 14%, var(--panel))`,
      }}
      aria-hidden="true"
    >
      {name.slice(0, 1)}
    </span>
  )
}

/** 列表行右侧的出场缩略条：章节多时按区间压缩成至多 MAX 格，区间内任一章出场即点亮 */
const MINI_MAX = 12

export function MiniStrip({ chapters, appeared }: { chapters: ChapterBrief[]; appeared: number[] }) {
  if (!chapters.length) return null
  const on = new Set(appeared)
  const buckets = Math.min(chapters.length, MINI_MAX)
  const cells = Array.from({ length: buckets }, (_, b) => {
    const from = Math.floor((b * chapters.length) / buckets)
    const to = Math.floor(((b + 1) * chapters.length) / buckets)
    return chapters.slice(from, to).some((c) => on.has(c.chapter_id))
  })
  return (
    <span className="mstrip" aria-label={`出场 ${appeared.length} / ${chapters.length} 章`}>
      {cells.map((lit, i) => (
        <i key={i} className={lit ? 'on' : ''} />
      ))}
    </span>
  )
}

/** 人物列表行：头像、名字、一行全书简介（无简介时显示重要度与出场章数）、出场缩略条 */
export function PersonRow({
  node,
  graph,
  chapters,
  onPick,
}: {
  node: GraphNode
  graph: GraphData | null
  chapters: ChapterBrief[]
  onPick: (personId: string) => void
}) {
  const appeared = node.chapter_ids ?? []
  const importance = IMPORTANCE_LABEL[node.importance] ?? ''
  const sub = !node.bio ? [importance, `出场 ${appeared.length || node.appearance_count} 章`].filter(Boolean).join(' · ') : node.bio
  return (
    <button type="button" className="person-row" onClick={() => onPick(node.person_id)}>
      <Avatar name={node.name} color={nodeColor(graph, node)} size="sm" />
      <span className="person-row-text">
        <span className="nm">{node.name}</span>
        <span className="sub">{sub}</span>
      </span>
      <MiniStrip chapters={chapters} appeared={appeared} />
    </button>
  )
}
