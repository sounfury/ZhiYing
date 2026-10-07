/**
 * 关系图的视觉编码：从 CSS 变量读调色板，按「场景 + 交互态 + 缩放」算出每个人物、连线、势力区块的 G6 样式。
 *
 * - 连线按强度：硬 = 实线深色，中 = 虚线，软 = 点线浅色（PRD §5.7.2）；单章模式本章依据加粗、其余淡化
 * - 人物：底色 = 势力浅色，描边 = 势力色，大小 = 重要度；节点内首字，名字在下方（衬线 + 画布色描边）
 * - 悬停：高亮该人与一度邻居及连边，其余淡出；悬停连线高亮两端
 * - 缩放分级：缩小时先藏龙套名字、再藏配角名字；主角名字与区块名反向放大保持可读
 * - 连线文字：放得下才显示；人多的图默认不显示，放大到足够大或悬停 / 选中相关人物时再显示
 *
 * 这里只算样式对象，不碰 G6 实例；主题切换时重新 readPalette 再整体重算即可，无需重建图。
 */
import { EDGE_LABEL_FONT, nameFontSize } from './layout'
import { FACTION_SLOTS } from '../../factions'
import type { Hardness, Scene, SceneCombo, SceneEdge, SceneNode } from './types'

export type Palette = {
  canvas: string
  ink: string
  ink2: string
  muted: string
  warn: string
  hard: string
  medium: string
  soft: string
  serif: string
  sans: string
  /** 势力色 / 浅底，下标 = 色槽（0 = 未归属） */
  faction: string[]
  factionSoft: string[]
}

/** 读当前主题下的 CSS 变量（深浅色切换后重读） */
export function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  const faction: string[] = []
  const factionSoft: string[] = []
  for (let i = 0; i <= FACTION_SLOTS; i++) {
    faction.push(v(`--f${i}`, '#8f877d'))
    factionSoft.push(v(`--f${i}-soft`, '#eeeae3'))
  }
  return {
    canvas: v('--canvas', '#faf7f0'),
    ink: v('--ink', '#1f1d1a'),
    ink2: v('--ink-2', '#4a4540'),
    muted: v('--muted', '#857d74'),
    warn: v('--warn', '#b5541f'),
    hard: v('--hard', '#2a2622'),
    medium: v('--medium', '#6d665e'),
    soft: v('--soft', '#aaa196'),
    serif: v('--serif', 'serif'),
    sans: v('--sans', 'sans-serif'),
    faction,
    factionSoft,
  }
}

/** 一次重算所需的交互态 */
export type StyleCtx = {
  palette: Palette
  zoom: number
  hoverNode: string | null
  hoverEdge: string | null
  selectedNode: string | null
  selectedEdge: string | null
}

/** 由悬停 / 选中推出的高亮集合 */
export type Focus = {
  /** 正在悬停：非高亮元素淡出 */
  dimming: boolean
  nodes: Set<string>
  edges: Set<string>
  /** 显示连线文字的线（悬停或选中相关） */
  labelEdges: Set<string>
}

export function computeFocus(scene: Scene, ctx: StyleCtx): Focus {
  const nodes = new Set<string>()
  const edges = new Set<string>()
  const labelEdges = new Set<string>()
  if (ctx.hoverNode) {
    nodes.add(ctx.hoverNode)
    scene.neighbors.get(ctx.hoverNode)?.forEach((id) => nodes.add(id))
    for (const e of scene.edges) {
      if (e.source === ctx.hoverNode || e.target === ctx.hoverNode) {
        edges.add(e.id)
        labelEdges.add(e.id)
      }
    }
  } else if (ctx.hoverEdge) {
    const e = scene.edges.find((x) => x.id === ctx.hoverEdge)
    if (e) {
      nodes.add(e.source)
      nodes.add(e.target)
      edges.add(e.id)
      labelEdges.add(e.id)
    }
  }
  const dimming = nodes.size > 0
  if (!dimming) {
    for (const e of scene.edges) {
      if (
        e.id === ctx.selectedEdge ||
        (ctx.selectedNode && (e.source === ctx.selectedNode || e.target === ctx.selectedNode))
      ) {
        labelEdges.add(e.id)
      }
    }
  }
  return { dimming, nodes, edges, labelEdges }
}

const DIM = 0.13

/** 首字：跳过开头的标点 / 空白 */
function initialOf(name: string): string {
  for (const ch of name) if (!/[\s·・.\-—()（）「」『』"'“”]/.test(ch)) return ch
  return name.slice(0, 1)
}

/** 名字在当前缩放下是否显示：屏幕字号太小就藏（主角始终显示） */
function nameVisible(n: SceneNode, zoom: number): boolean {
  if (n.node.importance === 'main' || n.center) return true
  const screen = nameFontSize(n.node.importance) * zoom
  return n.node.importance === 'supporting' ? screen >= 6.5 : screen >= 9
}

export function nodeStyle(n: SceneNode, ctx: StyleCtx, focus: Focus): Record<string, unknown> {
  const p = ctx.palette
  const imp = n.node.importance
  const selected = ctx.selectedNode === n.id
  const lit = focus.nodes.has(n.id)
  const dimmed = focus.dimming && !lit
  const fs = nameFontSize(imp)
  // 缩小看全貌时主角名字反向放大，保证屏幕上仍有约 11px
  const grow = imp === 'main' || n.center ? Math.min(2, Math.max(1, 0.75 / ctx.zoom)) : 1
  const showName = lit || selected || nameVisible(n, ctx.zoom)
  return {
    size: n.r * 2,
    fill: p.factionSoft[n.slot],
    stroke: selected ? p.warn : p.faction[n.slot],
    lineWidth: selected ? 3 : n.center || imp === 'main' ? 2.6 : 2,
    halo: selected,
    haloStroke: p.warn,
    haloLineWidth: 22,
    haloStrokeOpacity: 0.18,
    opacity: dimmed ? DIM : 1,
    cursor: 'pointer',
    zIndex: lit || selected ? 4 : 2,
    icon: n.r * ctx.zoom >= 6,
    iconText: initialOf(n.node.name),
    iconFill: p.ink,
    iconFontFamily: p.serif,
    iconFontWeight: 700,
    iconFontSize: Math.round(8 + n.r * 0.25),
    label: showName,
    labelText: n.node.name,
    labelPlacement: 'bottom',
    labelOffsetY: 3,
    labelFontFamily: p.serif,
    labelFontSize: fs * grow,
    labelFontWeight: imp === 'main' || n.center ? 700 : 500,
    labelFill: p.ink,
    labelStroke: p.canvas,
    labelLineWidth: 4 * grow,
    labelLineJoin: 'round',
  }
}

const LINE: Record<Hardness, { width: number; dash: number[] | undefined }> = {
  hard: { width: 2.2, dash: undefined },
  medium: { width: 1.7, dash: [7, 5] },
  soft: { width: 1.5, dash: [1.5, 5] },
}

export function edgeStyle(
  e: SceneEdge,
  scene: Scene,
  ctx: StyleCtx,
  focus: Focus,
): Record<string, unknown> {
  const p = ctx.palette
  const line = LINE[e.hardness]
  const selected = ctx.selectedEdge === e.id
  const lit = focus.edges.has(e.id)
  const past = scene.focusSingle && !e.inFocus
  const now = scene.focusSingle && e.inFocus

  let opacity = past ? 0.3 : 1
  if (focus.dimming) opacity = lit ? 1 : DIM * 0.8

  // 连线文字：相关的总显示；其余放得下、字不太小、且不是人多的缩小全貌时才显示
  const related = focus.labelEdges.has(e.id)
  const screenFont = EDGE_LABEL_FONT * ctx.zoom
  const showLabel =
    !!e.labelText &&
    (related ||
      (!focus.dimming && e.labelFits && screenFont >= 7.5 && (!scene.dense || ctx.zoom >= 0.95)))
  // 缩小时相关文字反向放大（悬停看人际时不必先放大）
  const grow = related ? Math.min(2.2, Math.max(1, 0.8 / ctx.zoom)) : 1

  return {
    stroke: selected ? p.warn : p[e.hardness],
    lineWidth: line.width + (now ? 1.6 : 0) + (selected ? 1.4 : lit ? 0.6 : 0),
    lineDash: line.dash,
    lineCap: 'round',
    opacity,
    cursor: 'pointer',
    increasedLineWidthForHitTesting: 12,
    zIndex: lit || selected ? 3 : now ? 1 : 0,
    label: showLabel,
    labelText: e.labelText,
    labelPlacement: related && !e.labelFits ? 0.5 : e.labelRatio,
    labelAutoRotate: false,
    labelOffsetX: 0,
    labelFontFamily: p.sans,
    labelFontSize: EDGE_LABEL_FONT * grow,
    labelFontWeight: now || related ? 600 : 400,
    labelFill: now || related ? p.ink : p.ink2,
    labelStroke: p.canvas,
    labelLineWidth: 4 * grow,
    labelLineJoin: 'round',
    labelOpacity: past && !related ? 0.55 : 1,
  }
}

export function comboStyle(c: SceneCombo, ctx: StyleCtx, focus: Focus): Record<string, unknown> {
  const p = ctx.palette
  // 缩小看全貌时块名反向放大
  const grow = Math.min(2.6, Math.max(1, 0.8 / ctx.zoom))
  return {
    fill: p.factionSoft[c.slot],
    fillOpacity: 0.72,
    stroke: p.faction[c.slot],
    strokeOpacity: 0.3,
    lineWidth: 1.2,
    lineDash: [4, 6],
    radius: 44,
    padding: [44, 30, 22, 30],
    opacity: focus.dimming ? 0.5 : 1,
    cursor: 'default',
    zIndex: -10,
    label: true,
    labelText: c.name,
    labelPlacement: 'top-left',
    labelTextAlign: 'left',
    labelTextBaseline: 'top',
    labelOffsetX: 22,
    labelOffsetY: 14,
    labelFill: p.faction[c.slot],
    labelFontFamily: p.serif,
    labelFontWeight: 700,
    labelFontSize: 14 * grow,
    labelLetterSpacing: 1,
    labelStroke: p.canvas,
    labelLineWidth: grow > 1 ? 3 * grow : 0,
    labelLineJoin: 'round',
  }
}
