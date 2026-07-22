/**
 * 关系分组：用于图布局聚拢与边样式。
 * 优先级：亲人 > 同学朋友 > 相识同场 > 无边孤立
 * （家族三代树形布局后续再做）
 */
import type { GraphEdge, GraphNode } from './api'

export type ClusterId = 'kin' | 'social' | 'weak' | 'isolate'

export const CLUSTER_META: Record<
  ClusterId,
  { label: string; fill: string; stroke: string; comboFill: string; order: number }
> = {
  kin: {
    label: '亲人',
    fill: '#fde8e8',
    stroke: '#c0392b',
    comboFill: 'rgba(192, 57, 43, 0.06)',
    order: 0,
  },
  social: {
    label: '同学 · 朋友 · 职场',
    fill: '#e8f1fb',
    stroke: '#2980b9',
    comboFill: 'rgba(41, 128, 185, 0.06)',
    order: 1,
  },
  weak: {
    label: '相识 · 同场',
    fill: '#f0f0f0',
    stroke: '#7f8c8d',
    comboFill: 'rgba(127, 140, 141, 0.06)',
    order: 2,
  },
  isolate: {
    label: '暂无关系',
    fill: '#f7f3eb',
    stroke: '#b0a89c',
    comboFill: 'rgba(176, 168, 156, 0.05)',
    order: 3,
  },
}

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

const RANK: Record<ClusterId, number> = {
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

/**
 * 节点主分组：参与过的最强关系类型；无边 → isolate。
 * 这样主角若有亲缘，会进「亲人」簇，同学边成为跨簇连线。
 */
export function assignNodeClusters(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, ClusterId> {
  const map = new Map<string, ClusterId>()
  for (const n of nodes) map.set(n.person_id, 'isolate')

  for (const e of edges) {
    const c = edgeCluster(e)
    for (const pid of [e.person_a, e.person_b]) {
      if (!map.has(pid)) continue
      const cur = map.get(pid)!
      if (RANK[c] > RANK[cur]) map.set(pid, c)
    }
  }
  return map
}

/** 仅用某类边做连通分量（后续家族子簇可用） */
export function connectedComponents(
  nodeIds: string[],
  edges: GraphEdge[],
  allow: (edge: GraphEdge) => boolean,
): string[][] {
  const set = new Set(nodeIds)
  const parent = new Map<string, string>()
  for (const id of nodeIds) parent.set(id, id)

  const find = (x: string): string => {
    let p = parent.get(x)!
    if (p !== x) {
      p = find(p)
      parent.set(x, p)
    }
    return p
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const e of edges) {
    if (!allow(e)) continue
    if (!set.has(e.person_a) || !set.has(e.person_b)) continue
    union(e.person_a, e.person_b)
  }

  const groups = new Map<string, string[]>()
  for (const id of nodeIds) {
    const r = find(id)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r)!.push(id)
  }
  return [...groups.values()]
}
