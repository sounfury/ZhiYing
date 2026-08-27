import type { GraphEdge, GraphFaction, GraphNode } from '../../api'
import { edgeCluster, type ClusterId } from '../../relationClusters'
import { factionColor, factionFill } from '../../factions'
import type { GraphSlice } from './types'
import { GEO, SECTOR_META, type Placement } from './layout'

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

export const EDGE_COLOR: Record<ClusterId, string> = {
  kin: '#c0392b',
  social: '#2980b9',
  weak: '#95a5a6',
  isolate: '#bdc3c7',
}

/** 势力名标签节点的 id 前缀（点击时要跳过） */
export const LABEL_PREFIX = '__f:'

export function importanceSize(importance: string, appearance: number): number {
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

/** 搜索聚焦时套上的高亮态（setElementState(id, ['focus'])） */
export const NODE_FOCUS_STATE = {
  stroke: '#c45c26',
  lineWidth: 6,
  halo: true,
  haloStroke: '#c45c26',
  haloLineWidth: 16,
  haloOpacity: 0.3,
  labelFontSize: 15,
  labelFontWeight: 700,
  labelFill: '#8c3d12',
}

export type G6NodeDatum = {
  id: string
  data: GraphNode | Record<string, never>
  style: Record<string, unknown>
}

export type G6EdgeDatum = {
  id: string
  source: string
  target: string
  data: GraphEdge
  style: Record<string, unknown>
}

export type G6Model = {
  nodes: G6NodeDatum[]
  edges: G6EdgeDatum[]
}

/** 把当前视图编成 G6 的 nodes/edges（含人物节点、势力名标签、边样式） */
export function buildG6Model(opts: {
  view: GraphSlice
  placed: Placement
  centerId: string
  cx: number
  cy: number
  useFactionLayout: boolean
  viewFactions: GraphFaction[]
  factionById: Map<string, GraphFaction>
  isEgoMode: boolean
}): G6Model {
  const {
    view,
    placed,
    centerId,
    cx,
    cy,
    useFactionLayout,
    viewFactions,
    factionById,
    isEgoMode,
  } = opts
  const { pos, sectorOf } = placed
  const nodeById = new Map(view.nodes.map((n) => [n.person_id, n]))

  /** 节点落块（势力模式取主势力，含后端传播推断的结果） */
  const blockOf = (n: GraphNode) =>
    n.primary_faction_id ? factionById.get(n.primary_faction_id) : undefined

  const personNodes: G6NodeDatum[] = view.nodes.map((n) => {
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
  const labelNodes: G6NodeDatum[] = useFactionLayout
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

  const edges: G6EdgeDatum[] = view.edges.map((e, i) => {
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
  })

  return { nodes: [...personNodes, ...labelNodes], edges }
}
