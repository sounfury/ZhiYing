import type { GraphData, GraphEdge, GraphFaction, GraphNode } from '../../api'
import { packWedges, type Bucket, type Wedge } from '../../graphLayout'
import { edgeCluster, RANK, type ClusterId } from '../../relationClusters'
import { factionColor } from '../../factions'
import type { GraphSlice, LegendItem, SectorId } from './types'

/** 几何参数：宁可图大留白，也不让节点贴在一起 */
export const GEO = {
  /** 相邻节点最小弦长：节点直径 56 + 中文名宽度 + 余量 */
  minChord: 148,
  /** 环间距：节点直径 + 名字行高 + 余量 */
  ringGap: 132,
  /** 楔形之间的角度缝 */
  wedgeGap: 0.17,
  /** 势力模式：所有块共用起始半径（中心留给主角与桥接人物） */
  factionInnerRadius: 340,
  /** 势力名标签离最外环的距离 */
  labelOffset: 104,
  minWedgeSpan: 0.26,
}

export const SECTOR_ORDER: SectorId[] = ['kin', 'social', 'weak', 'indirect', 'isolate']

export const SECTOR_META: Record<SectorId, { label: string; color: string; radius: number }> = {
  kin: { label: '亲人', color: '#c0392b', radius: 300 },
  social: { label: '同学朋友', color: '#2980b9', radius: 520 },
  weak: { label: '相识同场', color: '#7f8c8d', radius: 760 },
  indirect: { label: '间接相关', color: '#a67c52', radius: 1000 },
  isolate: { label: '暂无连线', color: '#b0a89c', radius: 1240 },
}

export type Placement = {
  pos: Map<string, { x: number; y: number }>
  wedges: Map<string, Wedge>
  /** 仅亲疏模式有：节点 → 关系档，用于描边取色 */
  sectorOf?: Map<string, SectorId>
}

export function pickCenter(nodes: GraphNode[], edges: GraphEdge[]): string | null {
  if (!nodes.length) return null
  const degree = new Map<string, number>()
  for (const n of nodes) degree.set(n.person_id, 0)
  for (const e of edges) {
    degree.set(e.person_a, (degree.get(e.person_a) ?? 0) + 1)
    degree.set(e.person_b, (degree.get(e.person_b) ?? 0) + 1)
  }
  const mains = nodes.filter((n) => n.importance === 'main')
  const pool = mains.length ? mains : [...nodes]
  pool.sort((a, b) => {
    const da = degree.get(a.person_id) ?? 0
    const db = degree.get(b.person_id) ?? 0
    if (db !== da) return db - da
    return (b.appearance_count ?? 0) - (a.appearance_count ?? 0)
  })
  return pool[0].person_id
}

function linkToCenterCluster(
  nodeId: string,
  centerId: string,
  edges: GraphEdge[],
): ClusterId | null {
  let best: ClusterId | null = null
  for (const e of edges) {
    const ends = [e.person_a, e.person_b]
    if (!ends.includes(nodeId) || !ends.includes(centerId)) continue
    const c = edgeCluster(e)
    if (!best || RANK[c] > RANK[best]) best = c
  }
  return best
}

export function sectorOfNode(
  nodeId: string,
  centerId: string,
  edges: GraphEdge[],
  neighborOf: Map<string, Set<string>>,
): SectorId {
  if (nodeId === centerId) return 'kin'
  const direct = linkToCenterCluster(nodeId, centerId, edges)
  if (direct === 'kin') return 'kin'
  if (direct === 'social') return 'social'
  if (direct === 'weak') return 'weak'
  const deg = neighborOf.get(nodeId)?.size ?? 0
  return deg > 0 ? 'indirect' : 'isolate'
}

/** 块内排序键：与中心越亲 → 越靠内环；同档按出场章数、再按名字稳定 */
function affinityOrderKey(
  n: GraphNode,
  centerId: string,
  edges: GraphEdge[],
  neighborOf: Map<string, Set<string>>,
): [number, number, string] {
  const cluster = linkToCenterCluster(n.person_id, centerId, edges)
  const rank = cluster
    ? RANK[cluster]
    : (neighborOf.get(n.person_id)?.size ?? 0) > 0
      ? -1
      : -2
  return [-rank, -(n.appearance_count ?? 0), n.name]
}

export function buildNeighborMap(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>()
  for (const n of nodes) m.set(n.person_id, new Set())
  for (const e of edges) {
    m.get(e.person_a)?.add(e.person_b)
    m.get(e.person_b)?.add(e.person_a)
  }
  return m
}

/** 势力模式：一块一楔形，块内按亲疏由内向外装填 */
export function placeByFaction(
  nodes: GraphNode[],
  edges: GraphEdge[],
  factions: GraphFaction[],
  centerId: string,
  cx: number,
  cy: number,
): Placement {
  const neighborOf = buildNeighborMap(nodes, edges)
  const nodeById = new Map(nodes.map((n) => [n.person_id, n]))
  const visible = new Set(nodes.map((n) => n.person_id))

  const buckets: Bucket[] = factions
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((f) => {
      const ids = f.member_ids.filter((id) => id !== centerId && visible.has(id))
      ids.sort((a, b) => {
        const na = nodeById.get(a)
        const nb = nodeById.get(b)
        if (!na || !nb) return a.localeCompare(b)
        const ka = affinityOrderKey(na, centerId, edges, neighborOf)
        const kb = affinityOrderKey(nb, centerId, edges, neighborOf)
        return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2], 'zh')
      })
      return { id: f.faction_id, ids }
    })

  const packed = packWedges(buckets, {
    cx,
    cy,
    minChord: GEO.minChord,
    ringGap: GEO.ringGap,
    wedgeGap: GEO.wedgeGap,
    innerRadius: GEO.factionInnerRadius,
    minWedgeSpan: GEO.minWedgeSpan,
  })

  const pos = new Map<string, { x: number; y: number }>(packed.pos)
  pos.set(centerId, { x: cx, y: cy })

  // 后端没覆盖到的人（理论上都会进 __unassigned，这里兜底不丢点）
  const orphans = nodes
    .map((n) => n.person_id)
    .filter((id) => !pos.has(id))
    .sort()
  if (orphans.length) {
    const r = packed.outerRadius + GEO.ringGap * 2
    orphans.forEach((id, i) => {
      const angle = (Math.PI * 2 * i) / orphans.length - Math.PI / 2
      pos.set(id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) })
    })
  }

  return { pos, wedges: packed.wedges }
}

/** 亲疏模式：一档一楔形，档有各自基准半径（原扇区太阳系，间距已按弦长撑开） */
export function placeByAffinity(
  nodes: GraphNode[],
  edges: GraphEdge[],
  centerId: string,
  cx: number,
  cy: number,
): Placement {
  const neighborOf = buildNeighborMap(nodes, edges)
  const bySector = new Map<SectorId, string[]>()
  for (const id of SECTOR_ORDER) bySector.set(id, [])
  for (const n of nodes) {
    if (n.person_id === centerId) continue
    bySector.get(sectorOfNode(n.person_id, centerId, edges, neighborOf))!.push(n.person_id)
  }

  const nameOf = (id: string) => nodes.find((n) => n.person_id === id)?.name ?? id
  const buckets: Bucket[] = SECTOR_ORDER.map((id) => {
    const ids = bySector.get(id)!
    ids.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh'))
    return { id, ids }
  })

  const packed = packWedges(buckets, {
    cx,
    cy,
    minChord: GEO.minChord,
    ringGap: GEO.ringGap,
    wedgeGap: GEO.wedgeGap,
    innerRadius: SECTOR_META.kin.radius,
    minWedgeSpan: GEO.minWedgeSpan,
    baseRadiusOf: (id) => SECTOR_META[id as SectorId].radius,
  })

  const pos = new Map<string, { x: number; y: number }>(packed.pos)
  pos.set(centerId, { x: cx, y: cy })
  const sectorOf = new Map<string, SectorId>()
  for (const id of SECTOR_ORDER) {
    for (const pid of bySector.get(id)!) sectorOf.set(pid, id)
  }
  return { pos, sectorOf, wedges: packed.wedges }
}

/**
 * 以某人 ego：只保留与其有边的节点 + 这些边。
 * 默认主角全图时不调用。
 */
export function egoSubgraph(full: GraphData, egoId: string): GraphSlice {
  const keep = new Set<string>([egoId])
  const edges = full.edges.filter((e) => {
    if (e.person_a === egoId) {
      keep.add(e.person_b)
      return true
    }
    if (e.person_b === egoId) {
      keep.add(e.person_a)
      return true
    }
    return false
  })
  const nodes = full.nodes.filter((n) => keep.has(n.person_id))
  return { nodes, edges }
}

/** 按当前可见节点裁势力块成员 */
export function factionsInView(
  factions: GraphFaction[],
  nodes: GraphNode[],
): GraphFaction[] {
  if (!factions.length) return []
  const visible = new Set(nodes.map((n) => n.person_id))
  return factions
    .map((f) => ({
      ...f,
      member_ids: f.member_ids.filter((id) => visible.has(id)),
      all_member_ids: f.all_member_ids.filter((id) => visible.has(id)),
    }))
    .filter((f) => f.member_ids.length > 0)
}

export function computeLegend(opts: {
  useFactionLayout: boolean
  viewFactions: GraphFaction[]
  view: GraphSlice
  centerId: string | null
}): LegendItem[] {
  const { useFactionLayout, viewFactions, view, centerId } = opts
  if (useFactionLayout) {
    return viewFactions.map((f) => ({
      key: f.faction_id,
      label: f.name,
      color: factionColor(f),
      count: f.member_ids.length,
    }))
  }
  if (!centerId) return []
  const neighborOf = buildNeighborMap(view.nodes, view.edges)
  const counts = new Map<SectorId, number>()
  for (const n of view.nodes) {
    if (n.person_id === centerId) continue
    const s = sectorOfNode(n.person_id, centerId, view.edges, neighborOf)
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  return SECTOR_ORDER.filter((id) => (counts.get(id) ?? 0) > 0).map((id) => ({
    key: id,
    label: SECTOR_META[id].label,
    color: SECTOR_META[id].color,
    count: counts.get(id)!,
  }))
}
