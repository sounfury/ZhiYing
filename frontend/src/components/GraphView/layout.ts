/**
 * 关系图的场景编排：决定画哪些人、各自放在哪、属于哪个势力区块、连线文字放哪。
 *
 * - 视图切片：中心视图取一度邻域，势力筛选裁块
 * - 多势力分身：主角 / 配角在有关系的非主势力块里再出现一次，相关连线改连分身（PRD §5.7.4）
 * - 势力分区（默认）：同心环为初始座位，再根据成员关系换座、松弛并预留姓名足迹；
 *   各块按实际矩形边界装箱，连边多的块挨着放（PRD §5.7.4）
 * - 亲疏扇区：以中心人物为圆心，按与他关系的硬 / 中 / 软 / 间接 / 无连线分档成扇区
 * - 平滑连线：避开沿途人物及姓名、拆开重叠通道；文字由 labels.ts 按当前缩放与交互态统一避让
 *
 * 只做纯计算，不碰 G6；颜色与交互态见 style.ts。
 */
import type { GraphData, GraphEdge, GraphFaction, GraphNode, GraphTag } from '../../api'
import { factionSlot, UNASSIGNED_FACTION_ID } from '../../factions'
import {
  assignSlots,
  packRects,
  packWedges,
  ringSlots,
  type Point,
  type RectBox,
} from '../../graphLayout'
import { refinePlacement, type PlacementBounds, type PlacementNode } from '../../graphPlacement'
import { routeEdges } from './routing'
import { nameFontSize, textWidth } from './geometry'
import type { GraphSlice, Hardness, Scene, SceneCombo, SceneEdge, SceneNode } from './types'

// ── 关系强度 ──────────────────────────────────────────────

const HARDNESS_BY_CATEGORY: Record<string, Hardness> = {
  硬关系: 'hard',
  中关系: 'medium',
  软关系: 'soft',
}

export const HARDNESS_RANK: Record<Hardness, number> = { hard: 3, medium: 2, soft: 1 }

/** 标签硬度：后端给 hardness（hard/medium/soft），旧数据按分类名兜底 */
export function tagHardness(tag: GraphTag): Hardness {
  const h = (tag as GraphTag & { hardness?: string }).hardness
  if (h === 'hard' || h === 'medium' || h === 'soft') return h
  return HARDNESS_BY_CATEGORY[tag.category] ?? 'medium'
}

/** 一条边多个标签取最强的决定线型 */
export function edgeHardness(edge: GraphEdge): Hardness {
  let best: Hardness = 'soft'
  for (const t of edge.tags) {
    const h = tagHardness(t)
    if (HARDNESS_RANK[h] > HARDNESS_RANK[best]) best = h
  }
  return best
}

// ── 尺寸 ──────────────────────────────────────────────

const IMPORTANCE_RANK: Record<string, number> = { main: 3, supporting: 2, minor: 1 }

/** 节点半径 = 重要度；中心视图的中心人物再放大一档 */
export function nodeRadius(importance: string, center = false): number {
  if (center) return 32
  return importance === 'main' ? 27 : importance === 'supporting' ? 20 : 14
}

// ── 视图切片 ──────────────────────────────────────────────

/** 默认中心：主角里连边最多的人（亲疏扇区的圆心） */
export function pickCenter(nodes: GraphNode[], edges: GraphEdge[]): string | null {
  if (!nodes.length) return null
  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.person_a, (degree.get(e.person_a) ?? 0) + 1)
    degree.set(e.person_b, (degree.get(e.person_b) ?? 0) + 1)
  }
  const mains = nodes.filter((n) => n.importance === 'main')
  const pool = [...(mains.length ? mains : nodes)]
  pool.sort(
    (a, b) =>
      (degree.get(b.person_id) ?? 0) - (degree.get(a.person_id) ?? 0) ||
      (b.appearance_count ?? 0) - (a.appearance_count ?? 0),
  )
  return pool[0].person_id
}

/** 中心视图：只保留与 egoId 有边的人 + 这些边 */
export function egoSubgraph(full: GraphData, egoId: string): GraphSlice {
  const keep = new Set<string>([egoId])
  const edges = full.edges.filter((e) => {
    if (e.person_a === egoId) keep.add(e.person_b)
    else if (e.person_b === egoId) keep.add(e.person_a)
    else return false
    return true
  })
  return { nodes: full.nodes.filter((n) => keep.has(n.person_id)), edges }
}

/** 按当前可见节点裁势力块成员，去掉空块 */
export function factionsInView(factions: GraphFaction[], nodes: GraphNode[]): GraphFaction[] {
  const visible = new Set(nodes.map((n) => n.person_id))
  return factions
    .map((f) => ({
      ...f,
      member_ids: f.member_ids.filter((id) => visible.has(id)),
      all_member_ids: f.all_member_ids.filter((id) => visible.has(id)),
    }))
    .filter((f) => f.member_ids.length > 0)
}

export function buildNeighborMap(nodes: GraphNode[], edges: GraphEdge[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>()
  for (const n of nodes) m.set(n.person_id, new Set())
  for (const e of edges) {
    m.get(e.person_a)?.add(e.person_b)
    m.get(e.person_b)?.add(e.person_a)
  }
  return m
}

// ── 布局 ──────────────────────────────────────────────

type Placed = {
  pos: Map<string, Point>
  /** 人 → 势力区块（仅势力分区） */
  comboOf: Map<string, string>
  combos: SceneCombo[]
}

/**
 * 块内参数：环间距要容下「节点 + 名字 + 余量」，弦长要容下一个中等长度的名字；
 * labelSlot 是核心人物每条连线在线中段要留的弧长（一个短关系名的宽度 + 余量）。
 */
const BLOCK = { minChord: 96, ringGap: 96, hubGap: 90, labelSlot: 46, margin: 48, padX: 64, padTop: 46, padBottom: 34 }

/** 两人之间最强关系的硬度等级（无边 = 0） */
function tieRank(edgesByPair: Map<string, Hardness>, a: string, b: string): number {
  const h = edgesByPair.get(a < b ? `${a}|${b}` : `${b}|${a}`)
  return h ? HARDNESS_RANK[h] : 0
}

/** 布局时预留姓名足迹，避免排座后再靠隐藏姓名解决拥挤。 */
function placementNode(n: GraphNode, egoId: string | null): PlacementNode {
  const fs = nameFontSize(n.importance)
  return { id: n.person_id, radius: nodeRadius(n.importance, n.person_id === egoId), nameWidth: textWidth(n.name, fs), nameHeight: fs + 3, nameGap: 7 }
}

/** 势力分区：环形初始座位 → 拓扑细化 → 按实际足迹装箱。 */
export function placeByFaction(
  slice: GraphSlice,
  factions: GraphFaction[],
  centerId: string | null,
  egoId: string | null = null,
): Placed {
  const nodeById = new Map(slice.nodes.map((n) => [n.person_id, n]))
  const edgesByPair = new Map<string, Hardness>()
  const degree = new Map<string, number>()
  for (const e of slice.edges) {
    const [a, b] = e.person_a < e.person_b ? [e.person_a, e.person_b] : [e.person_b, e.person_a]
    edgesByPair.set(`${a}|${b}`, edgeHardness(e))
    degree.set(a, (degree.get(a) ?? 0) + 1)
    degree.set(b, (degree.get(b) ?? 0) + 1)
  }

  // 1. 分块：后端主势力；没落到任何块的人归「未归属」
  const blockOf = new Map<string, string>()
  const blocks: { id: string; name: string; slot: number; ids: string[] }[] = []
  for (const f of [...factions].sort((a, b) => a.order - b.order)) {
    const ids = f.member_ids.filter((id) => nodeById.has(id) && !blockOf.has(id))
    if (!ids.length) continue
    ids.forEach((id) => blockOf.set(id, f.faction_id))
    blocks.push({ id: f.faction_id, name: f.name, slot: factionSlot(f), ids })
  }
  const orphans = slice.nodes.map((n) => n.person_id).filter((id) => !blockOf.has(id))
  if (orphans.length) {
    let un = blocks.find((b) => b.id === UNASSIGNED_FACTION_ID)
    if (!un) {
      un = { id: UNASSIGNED_FACTION_ID, name: '未归属', slot: 0, ids: [] }
      blocks.push(un)
    }
    for (const id of orphans) {
      un.ids.push(id)
      blockOf.set(id, UNASSIGNED_FACTION_ID)
    }
  }

  // 2. 块内排座：核心人物（中心人物 / 最重要且连边最多）居中，其余按与核心的亲疏、重要度排环
  const weight = (id: string) => {
    const n = nodeById.get(id)!
    return (IMPORTANCE_RANK[n.importance] ?? 1) * 100 + (degree.get(id) ?? 0) * 3 + (n.appearance_count ?? 0)
  }
  const layoutOf = new Map<string, { hub: string; rings: { radius: number; angles: number[]; ids: string[] }[]; half: number }>()
  for (const b of blocks) {
    const hub =
      centerId && b.ids.includes(centerId)
        ? centerId
        : [...b.ids].sort((x, y) => weight(y) - weight(x) || x.localeCompare(y))[0]
    const rest = b.ids
      .filter((id) => id !== hub)
      .sort(
        (x, y) =>
          tieRank(edgesByPair, hub, y) - tieRank(edgesByPair, hub, x) ||
          weight(y) - weight(x) ||
          x.localeCompare(y),
      )
    // 与核心直接相连的人全部坐第一环，其余从外一环起排，避免外圈的线穿过内圈
    const linked = rest.filter((id) => tieRank(edgesByPair, hub, id) > 0)
    const unlinked = rest.filter((id) => tieRank(edgesByPair, hub, id) === 0)
    const hubR = nodeRadius(nodeById.get(hub)!.importance)
    // 第一环半径取三者最大：让开核心；站得下所有相连的人；每条连线中段（半径一半处）留得下一个关系名
    const firstRadius = Math.max(
      hubR + BLOCK.hubGap,
      ((linked.length + 0.5) * BLOCK.minChord) / (Math.PI * 2),
      (linked.length * BLOCK.labelSlot) / Math.PI,
    )
    const inner = ringSlots(linked.length, { firstRadius, ringGap: BLOCK.ringGap, minChord: BLOCK.minChord })
    const innerOuter = inner.length ? inner[inner.length - 1].radius : firstRadius - BLOCK.ringGap
    const outer = ringSlots(unlinked.length, {
      firstRadius: Math.max(innerOuter + BLOCK.ringGap, hubR + BLOCK.hubGap),
      ringGap: BLOCK.ringGap,
      minChord: BLOCK.minChord,
    })
    const rings = [...inner, ...outer]
    rest.splice(0, rest.length, ...linked, ...unlinked)
    let cursor = 0
    const filled = rings.map((r) => {
      const ids = rest.slice(cursor, cursor + r.angles.length)
      cursor += r.angles.length
      return { ...r, ids }
    })
    const outermost = filled.length ? filled[filled.length - 1].radius : 0
    layoutOf.set(b.id, { hub, rings: filled, half: outermost + 28 })
  }

  // 3. 块间装箱：中心人物所在块先放，其余按人数从大到小，连边多的块挨着
  const links = new Map<string, Map<string, number>>()
  for (const e of slice.edges) {
    const ba = blockOf.get(e.person_a)
    const bb = blockOf.get(e.person_b)
    if (!ba || !bb || ba === bb) continue
    const w = HARDNESS_RANK[edgeHardness(e)]
    for (const [x, y] of [
      [ba, bb],
      [bb, ba],
    ]) {
      if (!links.has(x)) links.set(x, new Map())
      links.get(x)!.set(y, (links.get(x)!.get(y) ?? 0) + w)
    }
  }
  const centerBlock = centerId ? blockOf.get(centerId) : undefined
  const ordered = [...blocks].sort(
    (a, b) =>
      Number(b.id === centerBlock) - Number(a.id === centerBlock) ||
      Number(a.id === UNASSIGNED_FACTION_ID) - Number(b.id === UNASSIGNED_FACTION_ID) ||
      b.ids.length - a.ids.length,
  )
  const boxes: RectBox[] = ordered.map((b) => {
    const half = layoutOf.get(b.id)!.half
    return {
      id: b.id,
      w: half * 2 + BLOCK.padX * 2,
      h: half * 2 + BLOCK.padTop + BLOCK.padBottom,
      links: links.get(b.id) ?? new Map(),
    }
  })
  const centers = packRects(boxes, { margin: BLOCK.margin, aspect: 1.35 })

  // 4. 环上座位朝向：连向别块的人坐到朝那块的一侧，减少长线穿块
  const pos = new Map<string, Point>()
  for (const b of blocks) {
    const c = centers.get(b.id)!
    // 盒子中心 ≠ 环心：块名占了顶部，环心下移半个差
    const cy = c.y + (BLOCK.padTop - BLOCK.padBottom) / 2
    const { hub, rings } = layoutOf.get(b.id)!
    pos.set(hub, { x: c.x, y: cy })
    for (const ring of rings) {
      const prefs = ring.ids.map((id) => {
        let vx = 0
        let vy = 0
        for (const e of slice.edges) {
          const other = e.person_a === id ? e.person_b : e.person_b === id ? e.person_a : null
          if (!other) continue
          const ob = blockOf.get(other)
          if (!ob || ob === b.id) continue
          const oc = centers.get(ob)!
          const w = HARDNESS_RANK[edgeHardness(e)]
          const d = Math.hypot(oc.x - c.x, oc.y - c.y) || 1
          vx += ((oc.x - c.x) / d) * w
          vy += ((oc.y - c.y) / d) * w
        }
        const m = Math.hypot(vx, vy)
        return m > 0.01 ? { angle: Math.atan2(vy, vx), weight: m } : null
      })
      const angles = assignSlots(ring.angles, prefs)
      ring.ids.forEach((id, i) => {
        pos.set(id, { x: c.x + ring.radius * Math.cos(angles[i]), y: cy + ring.radius * Math.sin(angles[i]) })
      })
    }
  }

  // 5. 块内根据全部成员关系换座、松弛；核心固定，预留节点与姓名足迹。
  const refined = new Map<string, Map<string, Point>>()
  const bounds = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (const b of blocks) {
    const hub = layoutOf.get(b.id)!.hub
    const origin = pos.get(hub)!
    const members = b.ids.map((id) => nodeById.get(id)!)
    const local = refinePlacement({
      positions: new Map(b.ids.map((id) => { const p = pos.get(id)!; return [id, { x: p.x - origin.x, y: p.y - origin.y }] })),
      nodes: members.map((n) => placementNode(n, egoId)),
      edges: slice.edges,
      groups: new Map(b.ids.map((id) => [id, b.id])),
      fixedCenter: hub,
    })
    refined.set(b.id, local)
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
    for (const n of members) {
      const p = local.get(n.person_id)!, foot = placementNode(n, egoId)
      const halfWidth = Math.max(foot.radius + 4, foot.nameWidth / 2 + 4)
      x1 = Math.min(x1, p.x - halfWidth); x2 = Math.max(x2, p.x + halfWidth)
      y1 = Math.min(y1, p.y - foot.radius - 4)
      y2 = Math.max(y2, p.y + foot.radius + 7 + foot.nameHeight + 4)
    }
    bounds.set(b.id, { x: (x1 + x2) / 2, y: (y1 + y2) / 2, w: x2 - x1, h: y2 - y1 })
  }
  // 6. 细化后按真实矩形重新装箱，长名字和移动后的成员仍留在本势力内。
  const finalCenters = packRects(ordered.map((b) => {
    const box = bounds.get(b.id)!
    return { id: b.id, w: box.w + BLOCK.padX * 2, h: box.h + BLOCK.padTop + BLOCK.padBottom, links: links.get(b.id) ?? new Map() }
  }), { margin: BLOCK.margin, aspect: 1.35 })
  for (const b of blocks) {
    const center = finalCenters.get(b.id)!, box = bounds.get(b.id)!
    refined.get(b.id)!.forEach((p, id) => pos.set(id, {
      x: p.x + center.x - box.x,
      y: p.y + center.y - box.y + (BLOCK.padTop - BLOCK.padBottom) / 2,
    }))
  }

  return {
    pos,
    comboOf: blockOf,
    combos: blocks.map((b) => ({ id: b.id, name: b.name, slot: b.slot })),
  }
}

type Tier = 'hard' | 'medium' | 'soft' | 'indirect' | 'isolate'
const TIERS: Tier[] = ['hard', 'medium', 'soft', 'indirect', 'isolate']
const TIER_RADIUS: Record<Tier, number> = { hard: 190, medium: 340, soft: 490, indirect: 640, isolate: 790 }

/** 亲疏扇区：圆心是中心人物，一档一楔形，档内按势力再按名字排，同势力的人挨着 */
export function placeByAffinity(
  slice: GraphSlice,
  factions: GraphFaction[],
  centerId: string,
  egoId: string | null = null,
): Placed {
  const neighbors = buildNeighborMap(slice.nodes, slice.edges)
  const tierOf = new Map<string, Tier>()
  for (const e of slice.edges) {
    const other = e.person_a === centerId ? e.person_b : e.person_b === centerId ? e.person_a : null
    if (!other) continue
    const h = edgeHardness(e)
    const prev = tierOf.get(other)
    if (!prev || HARDNESS_RANK[h] > HARDNESS_RANK[prev as Hardness]) tierOf.set(other, h)
  }
  const orderOf = new Map(factions.map((f) => [f.faction_id, f.order]))
  const buckets = TIERS.map((tier) => ({
    id: tier,
    ids: slice.nodes
      .filter((n) => n.person_id !== centerId)
      .filter((n) => {
        const t = tierOf.get(n.person_id) ?? ((neighbors.get(n.person_id)?.size ?? 0) > 0 ? 'indirect' : 'isolate')
        return t === tier
      })
      .sort(
        (a, b) =>
          (orderOf.get(a.primary_faction_id ?? '') ?? 99) - (orderOf.get(b.primary_faction_id ?? '') ?? 99) ||
          a.name.localeCompare(b.name, 'zh'),
      )
      .map((n) => n.person_id),
  }))
  const packed = packWedges(buckets, {
    cx: 0,
    cy: 0,
    minChord: 100,
    ringGap: 86,
    wedgeGap: 0.14,
    innerRadius: TIER_RADIUS.hard,
    minWedgeSpan: 0.3,
    baseRadiusOf: (id) => TIER_RADIUS[id as Tier],
  })
  const initial = new Map(packed.pos)
  initial.set(centerId, { x: 0, y: 0 })
  const bounds = new Map<string, PlacementBounds>()
  const groups = new Map<string, string>()
  const nodeById = new Map(slice.nodes.map((n) => [n.person_id, n]))
  for (const bucket of buckets) {
    const wedge = packed.wedges.get(bucket.id)
    if (!wedge) continue
    for (const id of bucket.ids) {
      const p = initial.get(id)!, radius = Math.hypot(p.x, p.y)
      groups.set(id, `${bucket.id}:${nodeById.get(id)!.primary_faction_id ?? ''}`)
      bounds.set(id, { origin: { x: 0, y: 0 }, minRadius: Math.max(wedge.baseRadius, radius - 24), maxRadius: radius + 24, minAngle: wedge.a0 + 0.03, maxAngle: wedge.a1 - 0.03 })
    }
  }
  const pos = refinePlacement({ positions: initial, nodes: slice.nodes.map((n) => placementNode(n, egoId)), edges: slice.edges, groups, fixedCenter: centerId, bounds })
  return { pos, comboOf: new Map(), combos: [] }
}

// ── 多势力分身 ──────────────────────────────────────────────

type Cast = {
  /** 含分身的落座名单：分身是 person_id 换成分身 id、主势力换成所在块的人物副本 */
  slice: GraphSlice
  factions: GraphFaction[]
  /** 分身 id → 人物 id */
  personOf: Map<string, string>
  /** 每条边两端实际连到的节点 id，与 slice.edges 一一对应 */
  ends: [string, string][]
}

/**
 * 多势力分身（PRD §5.7.4）：主角 / 配角与另一势力块的人有关系、且自己也属于那个势力时，
 * 在那个块里生成分身并把这条关系连到分身上。按边生成，所以挂名而无连线的势力不会有分身。
 * 中心人物只出现一次。两端都能分身时取 person_a 一侧，保证结果确定。
 */
function castWithTwins(slice: GraphSlice, factions: GraphFaction[], egoId: string | null): Cast {
  const nodeById = new Map(slice.nodes.map((n) => [n.person_id, n]))
  const blockOf = new Map<string, string>()
  for (const f of [...factions].sort((a, b) => a.order - b.order)) {
    for (const id of f.member_ids) if (!blockOf.has(id)) blockOf.set(id, f.faction_id)
  }
  const personOf = new Map<string, string>()
  const blockOfTwin = new Map<string, string>()
  const twinToward = (id: string, other: string): string | null => {
    const n = nodeById.get(id)!
    const block = blockOf.get(other)
    if (!block || block === blockOf.get(id) || id === egoId) return null
    if ((n.importance !== 'main' && n.importance !== 'supporting') || !n.faction_ids.includes(block)) return null
    const twin = `${id}@${block}`
    personOf.set(twin, id)
    blockOfTwin.set(twin, block)
    return twin
  }
  const ends = slice.edges.map((e): [string, string] => {
    const a = twinToward(e.person_a, e.person_b)
    if (a) return [a, e.person_b]
    return [e.person_a, twinToward(e.person_b, e.person_a) ?? e.person_b]
  })
  const twins = [...personOf].map(([twin, person]) => ({
    ...nodeById.get(person)!,
    person_id: twin,
    primary_faction_id: blockOfTwin.get(twin)!,
  }))
  return {
    slice: {
      nodes: [...slice.nodes, ...twins],
      edges: slice.edges.map((e, i) => ({ ...e, person_a: ends[i][0], person_b: ends[i][1] })),
    },
    factions: factions.map((f) => ({
      ...f,
      member_ids: [...f.member_ids, ...twins.filter((t) => t.primary_faction_id === f.faction_id).map((t) => t.person_id)],
    })),
    personOf,
    ends,
  }
}

/** 连线文字：单章优先列本章依据的标签；最多两个，多的记 +N */
function edgeLabelText(edge: GraphEdge, focusSingle: boolean): string {
  let tags = [...edge.tags]
  if (focusSingle && tags.some((t) => t.in_focus_chapter)) tags = tags.filter((t) => t.in_focus_chapter)
  tags.sort((a, b) => b.display_score - a.display_score)
  const labels = [...new Set(tags.map((t) => t.label))]
  const head = labels.slice(0, 2).join(' · ')
  return labels.length > 2 ? `${head} +${labels.length - 2}` : head
}

/** 把视图切片编排成场景：位置、区块、线型、连线文字位置 */
export function buildScene(opts: {
  slice: GraphSlice
  factions: GraphFaction[]
  centerId: string | null
  egoId: string | null
  useFactionLayout: boolean
  focusSingle: boolean
}): Scene {
  const { slice, factions, centerId, egoId, useFactionLayout, focusSingle } = opts
  const factionById = new Map(factions.map((f) => [f.faction_id, f]))
  // 分身只在势力分区里有意义；亲疏扇区没有势力块，每人只画一次
  const cast = useFactionLayout || !centerId ? castWithTwins(slice, factions, egoId) : null
  const placed = cast
    ? placeByFaction(cast.slice, cast.factions, centerId, egoId)
    : placeByAffinity(slice, factions, centerId!, egoId)
  const personById = new Map(slice.nodes.map((n) => [n.person_id, n]))

  const nodes: SceneNode[] = (cast?.slice.nodes ?? slice.nodes).map((n) => {
    const p = placed.pos.get(n.person_id) ?? { x: 0, y: 0 }
    const personId = cast?.personOf.get(n.person_id) ?? n.person_id
    const ghost = personId !== n.person_id
    const center = personId === egoId
    const faction = n.primary_faction_id ? factionById.get(n.primary_faction_id) : undefined
    return {
      id: n.person_id,
      personId,
      ghost,
      node: personById.get(personId)!,
      x: p.x,
      y: p.y,
      slot: factionSlot(faction),
      r: nodeRadius(n.importance, center) * (ghost ? 0.85 : 1),
      center,
      combo: placed.comboOf.get(n.person_id),
    }
  })

  const edges: SceneEdge[] = slice.edges.map((e, i) => ({
    id: `e:${e.person_a}|${e.person_b}`,
    edge: e,
    source: cast?.ends[i][0] ?? e.person_a,
    target: cast?.ends[i][1] ?? e.person_b,
    controlPoints: [],
    path: [],
    hardness: edgeHardness(e),
    inFocus: e.tags.some((t) => t.in_focus_chapter),
    labelText: edgeLabelText(e, focusSingle),
  }))
  routeEdges(nodes, edges)

  return {
    nodes,
    edges,
    twins: [...(cast?.personOf ?? [])].map(([twin, person]) => ({ id: `twin:${twin}`, personId: person, source: person, target: twin })),
    combos: placed.combos,
    focusSingle,
    dense: nodes.length > 40 || edges.length > 70,
  }
}
