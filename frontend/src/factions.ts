/**
 * 势力块配色与文案。
 *
 * 势力是**归属**（块），关系是**连边**——两层正交（PRD §5.7.5 A）。
 * 所以势力用「面/块」通道（节点填色 + 块名 + 楔形），关系继续用线色/线型，
 * 两套色板刻意区分：势力偏中性哑光，关系边保留原来的红/蓝/灰。
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

/**
 * 势力块色板：哑光、彼此可分、深浅足够撑住白底描边。
 * 按块的环形序取用，保证相邻块颜色不撞。
 */
const FACTION_PALETTE = [
  '#2f6f5e', // 松绿
  '#a8582c', // 陶土
  '#3b5c93', // 靛蓝
  '#8a6a2f', // 赭黄
  '#7a3f6d', // 紫绛
  '#417a8c', // 湖蓝
  '#9c4040', // 砖红
  '#556b2a', // 橄榄
  '#6b5a8e', // 藤紫
  '#8c5a3c', // 褐
  '#2d6b7a', // 青
  '#7d4a55', // 玫褐
]

const UNASSIGNED_COLOR = '#a8a09a'

export function factionColor(faction: GraphFaction | undefined): string {
  if (!faction || faction.faction_id === UNASSIGNED_FACTION_ID) return UNASSIGNED_COLOR
  return FACTION_PALETTE[faction.order % FACTION_PALETTE.length]
}

/** 节点填色：势力色的极淡版，保证名字仍可读 */
export function factionFill(faction: GraphFaction | undefined): string {
  if (!faction || faction.faction_id === UNASSIGNED_FACTION_ID) return '#f6f4f1'
  const hex = factionColor(faction)
  return `${hex}14` // 8% alpha
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
