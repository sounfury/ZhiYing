/**
 * 关系分组：用于图布局聚拢与边样式。
 * 优先级：亲人 > 同学朋友 > 相识同场 > 无边孤立
 * （家族三代树形布局后续再做）
 */
import type { GraphEdge } from './api'

export type ClusterId = 'kin' | 'social' | 'weak' | 'isolate'

/** 簇强度：GraphView 布局与边主簇共用，避免两处各维护一份 */
export const RANK: Record<ClusterId, number> = {
  isolate: 0,
  weak: 1,
  social: 2,
  kin: 3,
}

export function categoryToCluster(category: string): ClusterId {
  // 这里只控制布局配色，不判断或限制具体关系；新分类采用通用社交样式。
  if (category === '亲属') return 'kin'
  if (category === '事件') return 'weak'
  return 'social'
}

/** 边的主分组 = 最强 tag 所属簇 */
export function edgeCluster(edge: GraphEdge): ClusterId {
  let best: ClusterId = 'weak'
  for (const t of edge.tags) {
    const c = categoryToCluster(t.category)
    if (RANK[c] > RANK[best]) best = c
  }
  return best
}
