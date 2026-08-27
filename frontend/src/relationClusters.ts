/**
 * 关系分组：用于图布局聚拢与边样式。
 * 优先级：亲人 > 同学朋友 > 相识同场 > 无边孤立
 * （家族三代树形布局后续再做）
 */
import type { GraphEdge } from './api'

export type ClusterId = 'kin' | 'social' | 'weak' | 'isolate'

const KIN_TYPES = new Set(['夫妻', '亲子', '兄妹', '表亲'])
const SOCIAL_TYPES = new Set([
  '师徒',
  '主仆',
  '上下级',
  '同学',
  '结盟',
  '敌对',
  '朋友',
])
const WEAK_TYPES = new Set(['相识', '同场'])

/** 簇强度：GraphView 布局与边主簇共用，避免两处各维护一份 */
export const RANK: Record<ClusterId, number> = {
  isolate: 0,
  weak: 1,
  social: 2,
  kin: 3,
}

export function typeToCluster(type: string): ClusterId {
  if (KIN_TYPES.has(type)) return 'kin'
  if (SOCIAL_TYPES.has(type)) return 'social'
  if (WEAK_TYPES.has(type)) return 'weak'
  return 'weak'
}

/** 边的主分组 = 最强 tag 所属簇 */
export function edgeCluster(edge: GraphEdge): ClusterId {
  let best: ClusterId = 'weak'
  for (const t of edge.tags) {
    const c = typeToCluster(t.type)
    if (RANK[c] > RANK[best]) best = c
  }
  return best
}
