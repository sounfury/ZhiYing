import { useEffect, useMemo, useRef } from 'react'
import { Graph } from '@antv/g6'
import type { GraphData, GraphEdge, GraphNode } from './api'
import { edgeCluster, type ClusterId } from './relationClusters'

/**
 * 扇区太阳系（固态）：
 * - 中心 = 主角；关系类占连续扇区
 * - 扇区按「每人最小张角」撑开，亲人扇区更疏
 * - 有区分度的关系（亲子/夫妻/师徒等）才在连中心的边上写字；
 *   同学/朋友/相识等同质 soft/mid 不写
 * - 只允许拖动画布 / 缩放
 */

type SectorId = 'kin' | 'social' | 'weak' | 'indirect' | 'isolate'

const SECTOR_ORDER: SectorId[] = ['kin', 'social', 'weak', 'indirect', 'isolate']

const SECTOR_META: Record<
  SectorId,
  {
    label: string
    color: string
    /** 基准半径 */
    radius: number
    /** 每人最小张角（弧度）——亲人更大，避免挤成一坨 */
    minAnglePerNode: number
  }
> = {
  kin: { label: '亲人', color: '#c0392b', radius: 220, minAnglePerNode: 0.42 }, // ~24°
  social: { label: '同学朋友', color: '#2980b9', radius: 360, minAnglePerNode: 0.2 }, // ~11°
  weak: { label: '相识同场', color: '#7f8c8d', radius: 500, minAnglePerNode: 0.16 },
  indirect: { label: '间接相关', color: '#a67c52', radius: 640, minAnglePerNode: 0.14 },
  isolate: { label: '暂无连线', color: '#b0a89c', radius: 780, minAnglePerNode: 0.12 },
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

/**
 * 按「每人最小张角」要扇区宽度；总角超 2π 时等比压缩，
 * 但仍保证亲人相对更宽。
 */
function allocateSectorAngles(
  counts: Map<SectorId, number>,
): Map<SectorId, { start: number; end: number }> {
  const GAP = 0.08
  const active = SECTOR_ORDER.filter((id) => (counts.get(id) ?? 0) > 0)
  const result = new Map<SectorId, { start: number; end: number }>()
  if (!active.length) return result

  // 需求角 = max(人数 * 最小张角, 扇区底角)
  const need = new Map<SectorId, number>()
  let sumNeed = 0
  for (const id of active) {
    const n = counts.get(id)!
    const minOne = SECTOR_META[id].minAnglePerNode
    // 底角：至少能放下，且亲人扇区额外 +15%
    let span = Math.max(n * minOne, minOne * 1.5)
    if (id === 'kin') span *= 1.2
    need.set(id, span)
    sumNeed += span
  }

  const gapTotal = GAP * active.length
  const usable = Math.PI * 2 - gapTotal
  const scale = sumNeed > usable ? usable / sumNeed : 1

  let cursor = -Math.PI / 2
  for (const id of SECTOR_ORDER) {
    if (!need.has(id)) continue
    const span = need.get(id)! * scale
    result.set(id, { start: cursor, end: cursor + span })
    cursor += span + GAP
  }
  return result
}

function placeSectorSolar(
  nodes: GraphNode[],
  edges: GraphEdge[],
  centerId: string,
  cx: number,
  cy: number,
): {
  pos: Map<string, { x: number; y: number; sector: SectorId }>
  counts: Map<SectorId, number>
} {
  const neighborOf = new Map<string, Set<string>>()
  for (const n of nodes) neighborOf.set(n.person_id, new Set())
  for (const e of edges) {
    neighborOf.get(e.person_a)?.add(e.person_b)
    neighborOf.get(e.person_b)?.add(e.person_a)
  }

  const bySector = new Map<SectorId, string[]>()
  for (const id of SECTOR_ORDER) bySector.set(id, [])

  for (const n of nodes) {
    if (n.person_id === centerId) continue
    const s = sectorOfNode(n.person_id, centerId, edges, neighborOf)
    bySector.get(s)!.push(n.person_id)
  }

  const nameOf = (id: string) =>
    nodes.find((n) => n.person_id === id)?.name ?? id
  for (const ids of bySector.values()) {
    ids.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh'))
  }

  const counts = new Map<SectorId, number>()
  for (const id of SECTOR_ORDER) {
    counts.set(id, bySector.get(id)!.length)
  }

  const sectorAngles = allocateSectorAngles(counts)
  const pos = new Map<string, { x: number; y: number; sector: SectorId }>()
  pos.set(centerId, { x: cx, y: cy, sector: 'kin' })

  for (const id of SECTOR_ORDER) {
    const ids = bySector.get(id)!
    if (!ids.length) continue
    const ang = sectorAngles.get(id)!
    const meta = SECTOR_META[id]
    const n = ids.length

    // 扇区内边距：至少留出半个最小张角，避免贴缝
    const rawSpan = ang.end - ang.start
    const pad = Math.min(rawSpan * 0.18, meta.minAnglePerNode * 0.45)
    const a0 = ang.start + pad
    const a1 = ang.end - pad
    const usable = Math.max(a1 - a0, 1e-3)

    // 亲人：≥3 人就交错半径，并拉大轨距；社交 ≥8 才双轨
    const stagger =
      id === 'kin' ? n >= 3 : id === 'social' ? n >= 8 : n >= 12
    const trackGap = id === 'kin' ? 52 : 34

    for (let i = 0; i < n; i++) {
      // 等分可用弧（含端点），n=1 居中
      const t = n === 1 ? 0.5 : i / (n - 1)
      const angle = a0 + usable * t
      let r = meta.radius
      if (stagger) {
        r = i % 2 === 0 ? meta.radius - trackGap * 0.55 : meta.radius + trackGap * 0.55
      }
      // 亲人再略外推，给标签/节点直径留空
      if (id === 'kin') r += 16
      pos.set(ids[i], {
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
        sector: id,
      })
    }
  }

  return { pos, counts }
}

/** 边视觉：连中心的最显眼；非中心 hard/有区分仍可见；弱社交边保留但更淡 */
function edgeStyleFor(
  e: GraphEdge,
  centerId: string,
): {
  opacity: number
  lineWidth: number
  labelText: string
} {
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

  // 外围 hard / 有区分关系：仍要看见（否则配角之间像没边）
  if (cluster === 'kin' || distinct) {
    return {
      opacity: 0.62,
      lineWidth: Math.min(2.6, 1.2 + score / 6),
      labelText: distinct, // 亲子/夫妻等外围也写
    }
  }
  if (cluster === 'social') {
    return {
      opacity: 0.38,
      lineWidth: 1.15,
      labelText: '',
    }
  }
  // 相识等同质弱边：很淡，点选侧栏仍可读
  return {
    opacity: 0.2,
    lineWidth: 0.85,
    labelText: '',
  }
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
  /** 非空时：仅显示该人 + 与其有边的一度邻居（由详情页按钮触发，非单击节点） */
  egoPersonId?: string | null
  onSelectEdge?: (edge: GraphEdge | null) => void
  onSelectNode?: (node: GraphNode | null) => void
  onExitEgo?: () => void
}

export function GraphView({
  data,
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

  /** 实际绘制用的节点/边：ego 模式裁一度邻域 */
  const view = useMemo(() => {
    if (!centerId) return { nodes: data.nodes, edges: data.edges }
    if (isEgoMode) return egoSubgraph(data, centerId)
    return { nodes: data.nodes, edges: data.edges }
  }, [data, centerId, isEgoMode])

  const legendCounts = useMemo(() => {
    if (!centerId) return new Map<SectorId, number>()
    const neighborOf = new Map<string, Set<string>>()
    for (const n of view.nodes) neighborOf.set(n.person_id, new Set())
    for (const e of view.edges) {
      neighborOf.get(e.person_a)?.add(e.person_b)
      neighborOf.get(e.person_b)?.add(e.person_a)
    }
    const m = new Map<SectorId, number>()
    for (const id of SECTOR_ORDER) m.set(id, 0)
    for (const n of view.nodes) {
      if (n.person_id === centerId) continue
      const s = sectorOfNode(n.person_id, centerId, view.edges, neighborOf)
      m.set(s, (m.get(s) ?? 0) + 1)
    }
    return m
  }, [view, centerId])

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
    const { pos } = placeSectorSolar(view.nodes, view.edges, centerId, cx, cy)

    const g6Data = {
      nodes: view.nodes.map((n) => {
        const p = pos.get(n.person_id) ?? {
          x: cx,
          y: cy,
          sector: 'isolate' as SectorId,
        }
        const isCenter = n.person_id === centerId
        const stroke = isCenter ? '#b7950b' : SECTOR_META[p.sector].color
        return {
          id: n.person_id,
          data: { ...n, sector: p.sector },
          style: {
            x: p.x,
            y: p.y,
            size: importanceSize(n.importance, n.appearance_count),
            labelText: n.name,
            labelPlacement: 'bottom' as const,
            labelOffsetY: 6,
            labelFontSize: isCenter ? 13 : 11,
            labelFontWeight: isCenter ? 700 : 400,
            labelFill: '#1a1a1a',
            fill: isCenter
              ? '#f5d76e'
              : n.importance === 'supporting'
                ? '#f7fafc'
                : '#ffffff',
            stroke,
            lineWidth: isCenter ? 3 : 2,
          },
        }
      }),
      edges: view.edges.map((e, i) => {
        const cluster = edgeCluster(e)
        // ego 子图里边都连中心，一律按「连中心」画清晰
        const vis = edgeStyleFor(e, centerId)
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
            labelPadding: [1, 5],
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
      padding: 48,
    })

    const pickId = (evt: unknown): string | undefined => {
      const e = evt as { target?: { id?: string } }
      return e.target?.id
    }

    graph.on('node:click', (evt) => {
      const id = pickId(evt)
      if (!id) return
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
  }, [data, view, centerId, isEgoMode, onSelectEdge, onSelectNode])

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

  return (
    <div className="graph-wrap">
      <div className="graph-legend" aria-label="扇区太阳系说明">
        <span className="legend-title">
          {isEgoMode ? `仅看：${centerName}` : `中心：${centerName}`}
        </span>
        {isEgoMode && (
          <button
            type="button"
            className="legend-reset"
            onClick={() => onExitEgo?.()}
          >
            回到全图（{defaultName}）
          </button>
        )}
        {SECTOR_ORDER.map((id) => {
          const n = legendCounts.get(id) ?? 0
          if (!n) return null
          const m = SECTOR_META[id]
          return (
            <span key={id} className="legend-item">
              <i style={{ background: m.color }} />
              {m.label}
              <em>{n}</em>
            </span>
          )
        })}
        <span className="legend-hint">
          {isEgoMode
            ? `一度邻居 ${Math.max(0, view.nodes.length - 1)} 人 · 详情或图例可回全图`
            : '单击人物看详情 · 详情里点「只看与此人的关系」· 拖动画布看图'}
        </span>
      </div>
      <div className="graph-canvas" ref={containerRef} />
    </div>
  )
}
