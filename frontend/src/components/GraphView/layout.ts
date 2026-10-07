/**
 * 关系图的场景编排：决定画哪些人、各自放在哪、属于哪个势力区块、连线文字放哪。
 *
 * - 视图切片：中心视图取一度邻域，势力筛选裁块
 * - 势力分区（默认）：每块内核心人物居中、其余按与核心的亲疏分环，环上座位朝向连得多的邻块；
 *   各块当矩形贪心装箱，连边多的块挨着放（PRD §5.7.5）
 * - 亲疏扇区：以中心人物为圆心，按与他关系的硬 / 中 / 软 / 间接 / 无连线分档成扇区
 * - 连线文字避让：沿线试几个位置，与人物、名字、已放文字都不重叠才算「放得下」
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

/** 名字字号：主角大、龙套小 */
export function nameFontSize(importance: string): number {
  return importance === 'main' ? 15 : importance === 'supporting' ? 13 : 11.5
}

/** 估算中文为主的文字宽度（不量真实字体：只用于避让，宁宽勿窄） */
export function textWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) {
    if (ch === '·' || ch === ' ') w += 0.5
    else if (ch.charCodeAt(0) < 128) w += 0.58
    else w += 1
  }
  return w * fontSize
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

/** 块内参数：环间距要容下「节点 + 名字 + 余量」，弦长要容下一个中等长度的名字 */
const BLOCK = { minChord: 96, ringGap: 84, hubGap: 74, margin: 30, padX: 64, padTop: 46, padBottom: 34 }

/** 两人之间最强关系的硬度等级（无边 = 0） */
function tieRank(edgesByPair: Map<string, Hardness>, a: string, b: string): number {
  const h = edgesByPair.get(a < b ? `${a}|${b}` : `${b}|${a}`)
  return h ? HARDNESS_RANK[h] : 0
}

/** 势力分区：块内同心环 + 块间矩形装箱 */
export function placeByFaction(
  slice: GraphSlice,
  factions: GraphFaction[],
  centerId: string | null,
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
    const hubR = nodeRadius(nodeById.get(hub)!.importance)
    const rings = ringSlots(rest.length, {
      firstRadius: hubR + BLOCK.hubGap,
      ringGap: BLOCK.ringGap,
      minChord: BLOCK.minChord,
    })
    let cursor = 0
    const filled = rings.map((r) => {
      const ids = rest.slice(cursor, cursor + r.angles.length)
      cursor += r.angles.length
      return { ...r, ids }
    })
    const outer = filled.length ? filled[filled.length - 1].radius : 0
    layoutOf.set(b.id, { hub, rings: filled, half: outer + 28 })
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
  const pos = new Map(packed.pos)
  pos.set(centerId, { x: 0, y: 0 })
  return { pos, comboOf: new Map(), combos: [] }
}

// ── 连线文字避让 ──────────────────────────────────────────────

type Box = [number, number, number, number]
const hit = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const LABEL_TRIES = [0.5, 0.38, 0.62, 0.28, 0.72, 0.2, 0.8]
export const EDGE_LABEL_FONT = 11.5

/** 给每条线找一个不压人、不压名字、不压别的线文字的位置；找不到就标记放不下 */
function placeEdgeLabels(nodes: SceneNode[], edges: SceneEdge[], focusSingle: boolean) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const boxes: Box[] = []
  for (const n of nodes) {
    boxes.push([n.x - n.r - 2, n.y - n.r - 2, n.x + n.r + 2, n.y + n.r + 2])
    const fs = nameFontSize(n.node.importance)
    const w = textWidth(n.node.name, fs) / 2 + 3
    boxes.push([n.x - w, n.y + n.r + 3, n.x + w, n.y + n.r + 6 + fs])
  }
  const prio = (e: SceneEdge) =>
    (focusSingle && e.inFocus ? 100 : 0) +
    HARDNESS_RANK[e.hardness] * 10 +
    (byId.get(e.source)!.r + byId.get(e.target)!.r) / 10
  for (const e of [...edges].sort((a, b) => prio(b) - prio(a))) {
    const s = byId.get(e.source)!
    const t = byId.get(e.target)!
    const len = Math.hypot(t.x - s.x, t.y - s.y) || 1
    const ux = (t.x - s.x) / len
    const uy = (t.y - s.y) / len
    const ax = s.x + ux * s.r
    const ay = s.y + uy * s.r
    const bx = t.x - ux * t.r
    const by = t.y - uy * t.r
    const w = textWidth(e.labelText, EDGE_LABEL_FONT) + 8
    const h = EDGE_LABEL_FONT + 6
    e.labelFits = false
    e.labelRatio = 0.5
    if (!e.labelText || len - s.r - t.r < Math.min(w, 60)) continue
    for (const r of LABEL_TRIES) {
      const x = ax + (bx - ax) * r
      const y = ay + (by - ay) * r
      const box: Box = [x - w / 2, y - h / 2, x + w / 2, y + h / 2]
      if (boxes.some((b) => hit(b, box))) continue
      boxes.push(box)
      e.labelFits = true
      e.labelRatio = r
      break
    }
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
  const placed =
    useFactionLayout || !centerId
      ? placeByFaction(slice, factions, centerId)
      : placeByAffinity(slice, factions, centerId)

  const nodes: SceneNode[] = slice.nodes.map((n) => {
    const p = placed.pos.get(n.person_id) ?? { x: 0, y: 0 }
    const center = n.person_id === egoId
    const faction = n.primary_faction_id ? factionById.get(n.primary_faction_id) : undefined
    return {
      id: n.person_id,
      node: n,
      x: p.x,
      y: p.y,
      slot: factionSlot(faction),
      r: nodeRadius(n.importance, center),
      center,
      combo: placed.comboOf.get(n.person_id),
    }
  })

  const edges: SceneEdge[] = slice.edges.map((e) => ({
    id: `e:${e.person_a}|${e.person_b}`,
    edge: e,
    source: e.person_a,
    target: e.person_b,
    hardness: edgeHardness(e),
    inFocus: e.tags.some((t) => t.in_focus_chapter),
    labelText: edgeLabelText(e, focusSingle),
    labelRatio: 0.5,
    labelFits: false,
  }))
  placeEdgeLabels(nodes, edges, focusSingle)

  return {
    nodes,
    edges,
    combos: placed.combos,
    focusSingle,
    dense: nodes.length > 40 || edges.length > 70,
    neighbors: buildNeighborMap(slice.nodes, slice.edges),
  }
}
