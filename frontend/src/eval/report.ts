/** 评测报告的展示用计算：问题判定、每章问题数、标准关系两端与可接受类型的文字。 */
import type { ChapterReport, RelationCheck, Tier, TypeCriteria } from './evalApi'

/** 必有关系算作问题：没找到（且不属于已有强 / 中关系的弱关系），或方向反了 */
export const isProblem = (c: RelationCheck) => (!c.hit && !c.excused) || c.direction_correct === false

/** 不扣分：找到，或弱关系漏检但已有强 / 中关系 */
export const isSatisfied = (c: RelationCheck) => c.hit || c.excused

export const TIER_LABEL: Record<Tier, string> = { HARD: '强关系', MEDIUM: '中关系', SOFT: '弱关系' }

/** 一章的问题数：必有漏检、方向错误、禁止项违反 */
export function chapterProblems(c: ChapterReport): number {
  return c.required.filter(isProblem).length + c.forbidden.filter((f) => f.violated).length
}

/** 有向写「源 → 目标」，无向写「甲 — 乙」 */
export function goldPair(g: { person_a: string; person_b: string; source?: string | null }) {
  if (!g.source) return `${g.person_a} — ${g.person_b}`
  const target = g.source === g.person_a ? g.person_b : g.person_a
  return `${g.source} → ${target}`
}

export function criteriaText(c: TypeCriteria, typeLabel: (id: string) => string) {
  const parts = c.type_ids.map(typeLabel)
  if (c.keywords.length) parts.push(`本书新建类型名含「${c.keywords.join(' / ')}」`)
  return parts.join('、')
}
