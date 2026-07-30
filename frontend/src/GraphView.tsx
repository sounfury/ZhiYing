import { useEffect, useMemo, useRef } from 'react'
import { Graph } from '@antv/g6'
import type { GraphData, GraphEdge, GraphFaction, GraphNode } from './api'
import { edgeCluster, type ClusterId } from './relationClusters'
import { packWedges, type Bucket, type Wedge } from './graphLayout'
import {
  UNASSIGNED_FACTION_ID,
  factionColor,
  factionFill,
  indexFactions,
} from './factions'

/**
 * 两种布局模式，同一套极坐标几何（graphLayout.ts）：
 *
 * - faction（默认，百人级大图主路径，PRD §4.5）
 *     θ = 势力块（学校 / 教会 / 家族…），r = 块内亲疏（越靠内越亲）
 *     解决「朋友太多杂糅一环」：朋友按所属团体散到不同楔形，仍按亲疏分环
 * - affinity（辅模式，原扇区太阳系）
 *     θ = 关系档，r = 该档基准半径 + 环内装填
 *
 * 两者的间距都由 fillWedge 的弦长约束保证不重叠——图会大，缩放后可读。
 */

export type LayoutMode = 'faction' | 'affinity'

/** 几何参数：宁可图大留白，也不让节点贴在一起 */
const GEO = {
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

type SectorId = 'kin' | 'social' | 'weak' | 'indirect' | 'isolate'

const SECTOR_ORDER: SectorId[] = ['kin', 'social', 'weak', 'indirect', 'isolate']

const SECTOR_META: Record<SectorId, { label: string; color: string; radius: number }> = {
  kin: { label: '亲人', color: '#c0392b', radius: 300 },
  social: { label: '同学朋友', color: '#2980b9', radius: 520 },
  weak: { label: '相识同场', color: '#7f8c8d', radius: 760 },
  indirect: { label: '间接相关', color: '#a67c52', radius: 1000 },
  isolate: { label: '暂无连线', color: '#b0a89c', radius: 1240 },
}

/** 有角色区分、值得写在边上的 type；同学/朋友/相识/同场不写 */
const DISTINCT_LABEL_TYPES = new Set([
  '夫妻',
  '亲子',
  '兄妹',
  '表亲',
  '师徒',
  '主仆',
  '上下级',
  '敌对',
  '结盟',
])

const EDGE_COLOR: Record<ClusterId, string> = {
  kin: '#c0392b',
  social: '#2980b9',
  weak: '#95a5a6',
  isolate: '#bdc3c7',
}

const RANK: Record<ClusterId, number> = {
  isolate: 0,
  weak: 1,
  social: 2,
  kin: 3,
}

/** 势力名标签节点的 id 前缀（点击时要跳过） */
const LABEL_PREFIX = '__f:'

/** 搜索命中后的聚焦动画 */
const FOCUS = {
  /** 平移到视口中心的时长 */
  panMs: 520,
  /** 随后推近的时长 */
  zoomMs: 420,
  /** 目标缩放：百人大图 fitView 后通常只有 0.3 左右，推到这个级别才看得清名字 */
  zoom: 1.05,
  /** 高亮保留时长；之后自动褪去，避免残留一个红圈 */
  holdMs: 3200,
}

/** 搜索聚焦请求：nonce 变化才重新播动画（同一人可反复聚焦） */
export type FocusRequest = { personId: string; nonce: number }

function importanceSize(importance: string, appearance: number): number {
  const base = importance === 'main' ? 48 : importance === 'supporting' ? 34 : 26
  return Math.min(56, base + Math.min(appearance, 5))
}

/** 边上展示文案：只取有区分度的 type；多标签取 display_score 最高 */
function distinctEdgeLabel(edge: GraphEdge): string {
  const hits = edge.tags.filter((t) => DISTINCT_LABEL_TYPES.has(t.type))
  if (!hits.length) return ''
  hits.sort((a, b) => b.display_score - a.display_score)
  return hits[0].type
}

function pickCenter(nodes: GraphNode[], edges: GraphEdge[]): string | null {
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

function sectorOfNode(
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

function buildNeighborMap(
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

type Placement = {
  pos: Map<string, { x: number; y: number }>
  wedges: Map<string, Wedge>
  /** 仅亲疏模式有：节点 → 关系档，用于描边取色 */
  sectorOf?: Map<string, SectorId>
}

/** 势力模式：一块一楔形，块内按亲疏由内向外装填 */
function placeByFaction(
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
function placeByAffinity(
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

/** 边视觉：连中心的最显眼；跨势力边要看得见（它解释块与块怎么连起来） */
function edgeStyleFor(
  e: GraphEdge,
  centerId: string,
  crossFaction: boolean,
): { opacity: number; lineWidth: number; labelText: string } {
  const top = e.tags[0]
  const cluster = edgeCluster(e)
  const touchesCenter = e.person_a === centerId || e.person_b === centerId
  const distinct = distinctEdgeLabel(e)
  const score = top?.display_score ?? 1

  if (touchesCenter) {
    return {
      opacity: 0.85,
      lineWidth: Math.min(3.2, 1.3 + score / 5),
      labelText: distinct,
    }
  }

  if (cluster === 'kin' || distinct) {
    return {
      opacity: 0.62,
      lineWidth: Math.min(2.6, 1.2 + score / 6),
      labelText: distinct,
    }
  }
  if (cluster === 'social') {
    return { opacity: crossFaction ? 0.4 : 0.26, lineWidth: 1.15, labelText: '' }
  }
  // 相识等同质弱边：很淡，点选侧栏仍可读
  return { opacity: crossFaction ? 0.24 : 0.16, lineWidth: 0.85, labelText: '' }
}

/**
 * 以某人 ego：只保留与其有边的节点 + 这些边。
 * 默认主角全图时不调用。
 */
function egoSubgraph(
  full: GraphData,
  egoId: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
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

type Props = {
  data: GraphData
  layoutMode?: LayoutMode
  /** 只看这几个势力块；空数组 = 全部。仅势力模式生效 */
  selectedFactions?: string[]
  /** 搜索命中后聚焦到某人（平移 + 推近 + 高亮） */
  focusRequest?: FocusRequest | null
  /** 非空时：仅显示该人 + 与其有边的一度邻居（由详情页按钮触发，非单击节点） */
  egoPersonId?: string | null
  onSelectEdge?: (edge: GraphEdge | null) => void
  onSelectNode?: (node: GraphNode | null) => void
  onExitEgo?: () => void
}

export function GraphView({
  data,
  layoutMode = 'faction',
  selectedFactions = [],
  focusRequest = null,
  egoPersonId = null,
  onSelectEdge,
  onSelectNode,
  onExitEgo,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)

  // 默认主角全图中心
  const defaultCenterId = useMemo(
    () => pickCenter(data.nodes, data.edges),
    [data.nodes, data.edges],
  )

  const isEgoMode = !!(
    egoPersonId && data.nodes.some((n) => n.person_id === egoPersonId)
  )

  const centerId = isEgoMode ? egoPersonId! : defaultCenterId

  /** 实际绘制用的节点/边：ego 模式裁一度邻域；否则按势力筛选裁块 */
  const view = useMemo(() => {
    if (!centerId) return { nodes: data.nodes, edges: data.edges }
    if (isEgoMode) return egoSubgraph(data, centerId)
    if (layoutMode !== 'faction' || !selectedFactions.length) {
      return { nodes: data.nodes, edges: data.edges }
    }
    // 块级下钻：只留选中块的人，主角始终保留当中心
    const keep = new Set(selectedFactions)
    const nodes = data.nodes.filter(
      (n) =>
        n.person_id === centerId ||
        (n.primary_faction_id !== null && keep.has(n.primary_faction_id)),
    )
    const ids = new Set(nodes.map((n) => n.person_id))
    const edges = data.edges.filter(
      (e) => ids.has(e.person_a) && ids.has(e.person_b),
    )
    return { nodes, edges }
  }, [data, centerId, isEgoMode, layoutMode, selectedFactions])

  /** 势力块（按当前视图裁成员）；无势力册时退回亲疏模式 */
  const viewFactions = useMemo(() => {
    if (!data.factions.length) return []
    const visible = new Set(view.nodes.map((n) => n.person_id))
    return data.factions
      .map((f) => ({
        ...f,
        member_ids: f.member_ids.filter((id) => visible.has(id)),
        all_member_ids: f.all_member_ids.filter((id) => visible.has(id)),
      }))
      .filter((f) => f.member_ids.length > 0)
  }, [data.factions, view.nodes])

  /**
   * 势力分区只在真有块可分时生效：只剩一个「未归属」块等于没分区，
   * 这时退回亲疏扇区，比画一个巨大的单块可读。
   */
  const useFactionLayout =
    layoutMode === 'faction' &&
    viewFactions.some((f) => f.faction_id !== UNASSIGNED_FACTION_ID)

  const factionById = useMemo(() => indexFactions(viewFactions), [viewFactions])

  const legend = useMemo(() => {
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
  }, [useFactionLayout, viewFactions, view, centerId])

  useEffect(() => {
    if (!containerRef.current || !centerId) return

    graphRef.current?.destroy()
    graphRef.current = null

    const nodeById = new Map(view.nodes.map((n) => [n.person_id, n]))
    // 全量 map 用于点选时仍能回传完整节点（侧栏）
    const fullNodeById = new Map(data.nodes.map((n) => [n.person_id, n]))
    const width = containerRef.current.clientWidth || 800
    const height = containerRef.current.clientHeight || 560
    const cx = width / 2
    const cy = height / 2

    const placed = useFactionLayout
      ? placeByFaction(view.nodes, view.edges, viewFactions, centerId, cx, cy)
      : placeByAffinity(view.nodes, view.edges, centerId, cx, cy)
    const { pos, sectorOf } = placed

    /** 节点落块（势力模式取主势力，含后端传播推断的结果） */
    const blockOf = (n: GraphNode) =>
      n.primary_faction_id ? factionById.get(n.primary_faction_id) : undefined

    const personNodes = view.nodes.map((n) => {
      const p = pos.get(n.person_id) ?? { x: cx, y: cy }
      const isCenter = n.person_id === centerId
      const faction = blockOf(n)
      const multiFaction = n.faction_ids.length > 1

      let stroke: string
      let fill: string
      if (useFactionLayout) {
        stroke = factionColor(faction)
        fill = isCenter ? '#f5d76e' : factionFill(faction)
      } else {
        const s = sectorOf?.get(n.person_id) ?? 'isolate'
        stroke = SECTOR_META[s].color
        fill = isCenter
          ? '#f5d76e'
          : n.importance === 'supporting'
            ? '#f7fafc'
            : '#ffffff'
      }
      if (isCenter) stroke = '#b7950b'

      return {
        id: n.person_id,
        data: { ...n },
        style: {
          x: p.x,
          y: p.y,
          size: importanceSize(n.importance, n.appearance_count),
          labelText: n.name,
          labelPlacement: 'bottom' as const,
          labelOffsetY: 6,
          labelFontSize: isCenter ? 14 : 12,
          labelFontWeight: isCenter ? 700 : 400,
          labelFill: '#1a1a1a',
          labelBackground: true,
          labelBackgroundFill: 'rgba(250,247,241,0.82)',
          labelBackgroundRadius: 3,
          labelPadding: [0, 3] as [number, number],
          fill,
          stroke,
          lineWidth: isCenter ? 3.5 : 2,
          // 跨势力的桥接人物：虚线描边 + 略粗，一眼看出「这人不止属于一块」
          lineDash: useFactionLayout && multiFaction && !isCenter ? [5, 3] : undefined,
        },
      }
    })

    // 势力名标签：楔形中线、最外环之外
    const labelNodes = useFactionLayout
      ? viewFactions.flatMap((f) => {
          const w = placed.wedges.get(f.faction_id)
          if (!w) return []
          const r = w.outerRadius + GEO.labelOffset
          return [
            {
              id: `${LABEL_PREFIX}${f.faction_id}`,
              data: {},
              style: {
                x: cx + r * Math.cos(w.mid),
                y: cy + r * Math.sin(w.mid),
                size: 2,
                fill: 'transparent',
                stroke: 'transparent',
                lineWidth: 0,
                labelText: `${f.name} · ${f.member_ids.length}`,
                labelPlacement: 'center' as const,
                labelFontSize: 18,
                labelFontWeight: 700,
                labelFill: factionColor(f),
                labelBackground: true,
                labelBackgroundFill: 'rgba(255,253,248,0.9)',
                labelBackgroundRadius: 6,
                labelPadding: [3, 10] as [number, number],
              },
            },
          ]
        })
      : []

    const g6Data = {
      nodes: [...personNodes, ...labelNodes],
      edges: view.edges.map((e, i) => {
        const cluster = edgeCluster(e)
        const fa = nodeById.get(e.person_a)?.primary_faction_id ?? null
        const fb = nodeById.get(e.person_b)?.primary_faction_id ?? null
        const crossFaction = useFactionLayout && !!fa && !!fb && fa !== fb
        const vis = edgeStyleFor(e, centerId, crossFaction)
        return {
          id: `e-${e.person_a}-${e.person_b}-${i}`,
          source: e.person_a,
          target: e.person_b,
          data: e,
          style: {
            stroke: EDGE_COLOR[cluster],
            lineWidth: vis.lineWidth,
            opacity: Math.max(vis.opacity, isEgoMode ? 0.75 : vis.opacity),
            labelText: vis.labelText,
            labelFontSize: 11,
            labelFill: EDGE_COLOR[cluster],
            labelFontWeight: 600,
            labelBackground: true,
            labelBackgroundFill: 'rgba(255,253,248,0.92)',
            labelBackgroundRadius: 3,
            labelPadding: [1, 5] as [number, number],
            endArrow: e.tags.some((t) => t.directed),
          },
        }
      }),
    }

    const graph = new Graph({
      container: containerRef.current,
      width,
      height,
      data: g6Data,
      layout: undefined,
      behaviors: ['drag-canvas', 'zoom-canvas'],
      animation: false,
      autoFit: 'view',
      padding: 64,
      node: {
        // 搜索聚焦时套上的高亮态（setElementState(id, ['focus'])）
        state: {
          focus: {
            stroke: '#c45c26',
            lineWidth: 6,
            halo: true,
            haloStroke: '#c45c26',
            haloLineWidth: 16,
            haloOpacity: 0.3,
            labelFontSize: 15,
            labelFontWeight: 700,
            labelFill: '#8c3d12',
          },
        },
      },
    })

    const pickId = (evt: unknown): string | undefined => {
      const e = evt as { target?: { id?: string } }
      return e.target?.id
    }

    graph.on('node:click', (evt) => {
      const id = pickId(evt)
      if (!id || id.startsWith(LABEL_PREFIX)) return
      // 单击只选中详情，不进入 ego（详情页按钮二次确认）
      onSelectNode?.(fullNodeById.get(id) ?? nodeById.get(id) ?? null)
      onSelectEdge?.(null)
    })

    graph.on('edge:click', (evt) => {
      const id = pickId(evt)
      if (!id) return
      const edgeData = g6Data.edges.find((x) => x.id === id)?.data as
        | GraphEdge
        | undefined
      onSelectEdge?.(edgeData ?? null)
      onSelectNode?.(null)
    })

    graph.on('canvas:click', () => {
      onSelectEdge?.(null)
      onSelectNode?.(null)
    })

    graph.render()
    graphRef.current = graph

    const fitLater = window.setTimeout(() => {
      try {
        void graph.fitView({ when: 'always', direction: 'both' })
      } catch {
        /* ignore */
      }
    }, 50)

    const onResize = () => {
      if (!containerRef.current || !graphRef.current) return
      graphRef.current.setSize(
        containerRef.current.clientWidth,
        containerRef.current.clientHeight,
      )
    }
    window.addEventListener('resize', onResize)

    return () => {
      window.clearTimeout(fitLater)
      window.removeEventListener('resize', onResize)
      graph.destroy()
      graphRef.current = null
    }
  }, [
    data,
    view,
    centerId,
    isEgoMode,
    useFactionLayout,
    viewFactions,
    factionById,
    onSelectEdge,
    onSelectNode,
  ])

  /**
   * 搜索聚焦：平移到视口中心 → 推近 → 高亮，几秒后自动褪去。
   *
   * 独立于建图 effect，所以不会为了播动画重建整张图。
   * 若同一次交互里筛选也变了（搜到的人被筛掉时 App 会清筛选），两个 state
   * 更新会批到同一次 commit：建图 effect 先跑，这里再跑，顺序天然正确。
   */
  useEffect(() => {
    if (!focusRequest) return
    const { personId } = focusRequest
    let cancelled = false
    let fade = 0

    // 等建图 effect 里的 fitView（50ms）落定，再开始平移
    const timer = window.setTimeout(async () => {
      const g = graphRef.current
      if (!g || cancelled) return
      try {
        if (!g.getNodeData().some((n) => n.id === personId)) return
        await g.focusElement(personId, {
          duration: FOCUS.panMs,
          easing: 'ease-in-out',
        })
        if (cancelled) return
        // 已经放得比目标更大时不要缩回去
        await g.zoomTo(Math.max(g.getZoom(), FOCUS.zoom), {
          duration: FOCUS.zoomMs,
          easing: 'ease-in-out',
        })
        if (cancelled) return
        await g.setElementState(personId, ['focus'])
        fade = window.setTimeout(() => {
          graphRef.current?.setElementState(personId, []).catch(() => {})
        }, FOCUS.holdMs)
      } catch {
        /* 图可能已被重建/销毁，聚焦失败无所谓 */
      }
    }, 140)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearTimeout(fade)
      graphRef.current?.setElementState(personId, []).catch(() => {})
    }
  }, [focusRequest])

  if (!data.nodes.length) {
    return (
      <div className="graph-empty">
        暂无节点。可能尚未分析，或过滤过严（试试降低 min_appearance）。
      </div>
    )
  }

  const centerName =
    data.nodes.find((n) => n.person_id === centerId)?.name ?? '主角'
  const defaultName =
    data.nodes.find((n) => n.person_id === defaultCenterId)?.name ?? '主角'
  const unassigned = viewFactions.find(
    (f) => f.faction_id === UNASSIGNED_FACTION_ID,
  )

  return (
    <div className="graph-wrap">
      <div className="graph-legend" aria-label="布局说明">
        <span className="legend-title">
          {isEgoMode ? `仅看：${centerName}` : `中心：${centerName}`}
        </span>
        <span className="legend-mode">
          {useFactionLayout ? '势力分区' : '亲疏扇区'}
        </span>
        {useFactionLayout && selectedFactions.length > 0 && (
          <span className="legend-mode">
            筛选中 {selectedFactions.length}/{data.factions.length} 块 ·{' '}
            {view.nodes.length} 人
          </span>
        )}
        {isEgoMode && (
          <button
            type="button"
            className="legend-reset"
            onClick={() => onExitEgo?.()}
          >
            回到全图（{defaultName}）
          </button>
        )}
        {legend.map((item) => (
          <span key={item.key} className="legend-item">
            <i style={{ background: item.color }} />
            {item.label}
            <em>{item.count}</em>
          </span>
        ))}
        <span className="legend-hint">
          {layoutMode === 'faction' && !useFactionLayout
            ? '尚无势力册：先点「抽取势力」，或用亲疏扇区模式看图'
            : useFactionLayout
              ? `角度=势力块，半径=块内亲疏（越靠内越亲）· 虚线圈=跨块桥接人物${
                  unassigned ? ` · 未归属 ${unassigned.member_ids.length} 人` : ''
                }`
              : '单击人物看详情 · 详情里点「只看与此人的关系」· 拖动画布看图'}
        </span>
      </div>
      <div className="graph-canvas" ref={containerRef} />
    </div>
  )
}
