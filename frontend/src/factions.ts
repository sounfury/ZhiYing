/**
 * 势力块配色与文案。
 *
 * 势力是**归属**（块），关系是**连边**——两层正交（PRD §5.7.5 A）。
 * 势力用「面 / 块」通道（节点底色与描边、半透明区块），关系只用线型与深浅，两套色板互不混用。
 * 颜色一律返回 CSS 变量（--f1…--f8，未归属 --f0，定义见 styles/graph.css），深浅色主题自动跟随；
 * 画布里要用真实色值时由图谱区读 getComputedStyle 解析同名变量。
 */

import type { GraphFaction } from './api'

export const UNASSIGNED_FACTION_ID = '__unassigned'

/** kind → 中文标签，图例与侧栏用 */
export const FACTION_KIND_LABEL: Record<string, string> = {
  school: '学校',
  religious: '教会',
  family: '家族',
  organization: '组织',
  movement: '思潮',
  stage: '阶段',
  other: '其他',
}

/** 势力色槽数量（--f1…--f8），超过的块按环形序循环取色 */
export const FACTION_SLOTS = 8

/** 势力 → 色槽：0 = 未归属 / 无势力，1…8 按块的环形序取，相邻块颜色不撞 */
export function factionSlot(faction: GraphFaction | undefined): number {
  if (!faction || faction.faction_id === UNASSIGNED_FACTION_ID) return 0
  return (faction.order % FACTION_SLOTS) + 1
}

/** 势力主色（描边、色点、文字） */
export function factionColor(faction: GraphFaction | undefined): string {
  return `var(--f${factionSlot(faction)})`
}

/** 势力浅底（节点底色、区块底色、头像底） */
export function factionFill(faction: GraphFaction | undefined): string {
  return `var(--f${factionSlot(faction)}-soft)`
}

export function factionLabel(faction: GraphFaction): string {
  const kind = FACTION_KIND_LABEL[faction.kind]
  return kind ? `${faction.name}·${kind}` : faction.name
}

/** 按 faction_id 建索引，兼容未归属块缺失的情况 */
export function indexFactions(
  factions: GraphFaction[],
): Map<string, GraphFaction> {
  return new Map(factions.map((f) => [f.faction_id, f]))
}
