/** 侧栏人物相关的纯函数：关系硬度、章节短名、人名简称、势力色、按出场排序。 */
import type { ChapterBrief, GraphData, GraphNode, GraphTag, Hardness } from '../api'
import { factionColor } from '../factions'
import { chapterShortNames } from '../chapterNames'

export const HARDNESS_ORDER: Hardness[] = ['hard', 'medium', 'soft']
export const HARDNESS_LABEL: Record<Hardness, string> = { hard: '硬', medium: '中', soft: '软' }

/** 关系硬度；旧数据没有 hardness 时按 category 文案推断 */
export function hardnessOf(tag: GraphTag): Hardness {
  if (tag.hardness === 'hard' || tag.hardness === 'medium' || tag.hardness === 'soft') return tag.hardness
  if (tag.category.includes('硬')) return 'hard'
  if (tag.category.includes('软')) return 'soft'
  return 'medium'
}

/** 章节格子里的短名：与章节条同一套章名，「第二章」→「二」，其余用阅读序号 */
export function chapterShort(chapters: ChapterBrief[], index: number): string {
  const m = chapterShortNames(chapters)[index]?.match(/^第\s*(\S{1,4}?)\s*[章回节卷部]$/)
  return m ? m[1] : String(index + 1)
}

/** 人名的简称（「斯蒂芬·迪达勒斯」→「斯蒂芬」），用于按钮与小标题 */
export function shortName(name: string): string {
  return name.split(/[·•・]/)[0] || name
}

/** 节点的主势力色；未归属为中性灰 */
export function nodeColor(graph: GraphData | null, node: GraphNode): string {
  const faction = graph?.factions.find((f) => f.faction_id === node.primary_faction_id)
  return factionColor(faction)
}

const IMPORTANCE_RANK: Record<string, number> = { main: 0, supporting: 1, minor: 2 }

/** 按出场章数（其次重要度、名字）排序 */
export function byAppearance(a: GraphNode, b: GraphNode): number {
  const ca = a.chapter_ids?.length ?? a.appearance_count
  const cb = b.chapter_ids?.length ?? b.appearance_count
  return (
    cb - ca ||
    (IMPORTANCE_RANK[a.importance] ?? 9) - (IMPORTANCE_RANK[b.importance] ?? 9) ||
    a.name.localeCompare(b.name, 'zh')
  )
}
