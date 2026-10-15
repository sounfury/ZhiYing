/**
 * 关系图 PNG 导出（PRD §5.7.5）：按当前场景用 Canvas 2D 重画一张完整图，不截屏。
 *
 * - 内容：当前视图的全部人物与连线（含被拖动后的位置），不受屏幕视口与缩放分级影响
 * - 连线：按场景里已绕行的路径画，与画布一致；有向关系画箭头
 * - 文字：人名全部显示；关系文字按 labels.ts 在 100% 缩放、无交互态下的避让结果标注（软关系不标）
 * - 附带：顶部书名与范围说明，底部图例（线型、本章、势力色）与水印
 * - 清晰度：默认 2 倍像素，图太大时按画布尺寸 / 面积上限降低倍数（iOS Safari 画布上限更小）
 *
 * 不画悬停、选中等交互态；配色取当前主题。视觉编码与 style.ts 保持一致，改那边要同步这里。
 */
import type { GraphFaction } from '../../api'
import { factionSlot } from '../../factions'
import { edgeDirection } from '../../relationDirection'
import { EDGE_LABEL_FONT, nameFontSize, pathPoint } from './geometry'
import { placeLabels } from './labels'
import { computeFocus, type Palette, type StyleCtx } from './style'
import type { Hardness, Scene, SceneNode } from './types'

export type PngMeta = {
  bookTitle: string
  /** 全书 / 第 N 章 / 前 N 章 */
  scope: string
  /** 视图说明，如「势力分区」「以 X 为中心」「只看：A、B」 */
  view: string[]
  /** 图例里列出的势力（当前视图里有人的） */
  factions: GraphFaction[]
  /** 亲疏扇区：图例加一句读法说明 */
  affinity: boolean
}

export type PngResult = { blob: Blob; width: number; height: number; scale: number }

type Pt = { x: number; y: number }
type Rect = { x0: number; y0: number; x1: number; y1: number }

/** 理想像素倍数：手机上双指放大后龙套名字（11.5px）仍清楚 */
const TARGET_SCALE = 2
const MAX_SIDE = 16384
/** iOS Safari 单张画布约 1677 万像素上限；桌面放宽，但也别让 PNG 编码卡太久 */
const MAX_AREA_IOS = 16_000_000
const MAX_AREA = 40_000_000
/** 图很小（中心视图两三个人）时，页面仍至少这么宽，放得下标题和图例 */
const MIN_WIDTH = 720
const GRAPH_MARGIN = 40

const LINE: Record<Hardness, { width: number; dash: number[] }> = {
  hard: { width: 2.2, dash: [] },
  medium: { width: 1.7, dash: [7, 5] },
  soft: { width: 1.5, dash: [1.5, 5] },
}
const COMBO_PADDING = { top: 44, right: 30, bottom: 22, left: 30 }

function isIOS(): boolean {
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

/** 首字：跳过开头的标点 / 空白（与 style.ts 一致） */
function initialOf(name: string): string {
  for (const ch of name) if (!/[\s·・.\-—()（）「」『』"'“”]/.test(ch)) return ch
  return name.slice(0, 1)
}

const emptyRect = (): Rect => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
function grow(r: Rect, x0: number, y0: number, x1: number, y1: number) {
  r.x0 = Math.min(r.x0, x0)
  r.y0 = Math.min(r.y0, y0)
  r.x1 = Math.max(r.x1, x1)
  r.y1 = Math.max(r.y1, y1)
}

const font = (weight: number, size: number, family: string) => `${weight} ${size}px ${family}`

/** 在给定宽度内放下文字：先缩字号（最多到 0.7 倍），仍放不下就截断加省略号 */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number, weight: number, size: number, family: string) {
  let s = size
  ctx.font = font(weight, s, family)
  while (ctx.measureText(text).width > maxW && s > size * 0.7) {
    s -= 1
    ctx.font = font(weight, s, family)
  }
  if (ctx.measureText(text).width <= maxW) return { text, size: s }
  let t = text
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1)
  return { text: `${t}…`, size: s }
}

/** 关系文字位置：常态视图在 100% 缩放、无悬停选中时的避让结果 */
function edgeLabelPositions(scene: Scene, p: Palette): Map<string, Pt> {
  const ctx: StyleCtx = { palette: p, zoom: 1, hoverNode: null, hoverEdge: null, selectedNode: null, selectedEdge: null }
  const { edges } = placeLabels(scene, ctx, computeFocus(scene, ctx))
  const at = new Map<string, Pt>()
  for (const e of scene.edges) {
    const l = edges.get(e.id)
    if (!l?.visible) continue
    const pt = pathPoint(e.path, l.ratio)
    at.set(e.id, { x: pt.x, y: pt.y + l.offsetY })
  }
  return at
}

type LegendItem =
  | { kind: 'line'; hardness: Hardness; label: string; width?: number }
  | { kind: 'dot'; color: string; label: string }

/**
 * 画出完整关系图并编码为 PNG。
 * @param positions 画布上人物的当前位置（拖动过的以此为准）；缺省用场景编排的位置
 */
export async function renderGraphPng(
  scene: Scene,
  positions: Map<string, Pt> | null,
  p: Palette,
  meta: PngMeta,
): Promise<PngResult> {
  await document.fonts?.ready

  const measure = document.createElement('canvas').getContext('2d')
  if (!measure) throw new Error('浏览器不支持画布，无法导出图片')

  const nodes = scene.nodes.map((n) => {
    const at = positions?.get(n.id) ?? { x: n.x, y: n.y }
    return { n, x: at.x, y: at.y, r: n.r }
  })
  const byId = new Map(nodes.map((v) => [v.n.id, v]))

  // ── 1. 图的范围：人物（含名字）、势力区块、连线文字 ──
  const nameOf = (n: SceneNode) => {
    const size = nameFontSize(n.node.importance)
    const weight = n.node.importance === 'main' || n.center ? 700 : 500
    return { size, weight }
  }
  const nodeBox = new Map<string, Rect>()
  for (const v of nodes) {
    const { size, weight } = nameOf(v.n)
    measure.font = font(weight, size, p.serif)
    const half = Math.max(v.r + 1.5, measure.measureText(v.n.node.name).width / 2 + 2)
    nodeBox.set(v.n.id, { x0: v.x - half, y0: v.y - v.r - 1.5, x1: v.x + half, y1: v.y + v.r + 3 + size * 1.3 })
  }
  const comboRects = new Map<string, Rect>()
  for (const v of nodes) {
    if (!v.n.combo) continue
    const b = nodeBox.get(v.n.id)!
    const r = comboRects.get(v.n.combo) ?? emptyRect()
    grow(r, b.x0, b.y0, b.x1, b.y1)
    comboRects.set(v.n.combo, r)
  }
  for (const r of comboRects.values()) {
    r.x0 -= COMBO_PADDING.left
    r.y0 -= COMBO_PADDING.top
    r.x1 += COMBO_PADDING.right
    r.y1 += COMBO_PADDING.bottom
  }
  const bounds = emptyRect()
  for (const b of nodeBox.values()) grow(bounds, b.x0, b.y0, b.x1, b.y1)
  for (const r of comboRects.values()) grow(bounds, r.x0, r.y0, r.x1, r.y1)
  for (const e of scene.edges) for (const pt of e.path) grow(bounds, pt.x, pt.y, pt.x, pt.y)
  const labelAt = edgeLabelPositions(scene, p)
  measure.font = font(600, EDGE_LABEL_FONT, p.sans)
  for (const e of scene.edges) {
    const at = labelAt.get(e.id)
    if (!at) continue
    const w = measure.measureText(e.labelText).width / 2 + 3
    grow(bounds, at.x - w, at.y - EDGE_LABEL_FONT, at.x + w, at.y + EDGE_LABEL_FONT)
  }
  if (!Number.isFinite(bounds.x0)) throw new Error('当前视图没有人物，无法导出图片')

  const graphW = bounds.x1 - bounds.x0 + GRAPH_MARGIN * 2
  const graphH = bounds.y1 - bounds.y0 + GRAPH_MARGIN * 2

  // ── 2. 版面：页眉（书名、范围）+ 图 + 图例 + 页脚（说明、水印）。字号随页宽放大，缩略图里也看得清 ──
  const width = Math.max(MIN_WIDTH, graphW)
  const u = Math.max(1, width / 1100)
  const pad = 32 * u
  const innerW = width - pad * 2

  const titleSize = 30 * u
  const subSize = 15 * u
  const headerH = pad + titleSize * 1.25 + 10 * u + subSize * 1.4 + 12 * u

  const legendSize = 14 * u
  const rowH = legendSize * 2
  const items: LegendItem[] = [
    { kind: 'line', hardness: 'hard', label: '强关系' },
    { kind: 'line', hardness: 'medium', label: '中关系' },
    { kind: 'line', hardness: 'soft', label: '弱关系' },
  ]
  if (scene.focusSingle) items.push({ kind: 'line', hardness: 'hard', label: '本章出现', width: 3.8 })
  for (const f of meta.factions) {
    items.push({ kind: 'dot', color: p.faction[factionSlot(f)], label: f.name })
  }
  const swatchW = 30 * u
  const gap = 22 * u
  const itemW = (it: LegendItem) => {
    measure.font = font(400, legendSize, p.sans)
    return (it.kind === 'line' ? swatchW : legendSize * 0.8) + 8 * u + measure.measureText(it.label).width
  }
  // 线型一行起，势力接着排，排不下换行
  const placedItems: { it: LegendItem; x: number; row: number }[] = []
  let cx = 0
  let row = 0
  items.forEach((it, i) => {
    const w = Math.min(itemW(it), innerW)
    const firstFaction = it.kind === 'dot' && (i === 0 || items[i - 1].kind === 'line')
    if (cx > 0 && (cx + w > innerW || firstFaction)) {
      row += 1
      cx = 0
    }
    placedItems.push({ it, x: cx, row })
    cx += w + gap
  })
  const hint = meta.affinity ? '离中心越近，与中心人物的关系越硬' : ''
  const legendH = 14 * u + (row + 1) * rowH + (hint ? rowH * 0.9 : 0)
  const footSize = 13 * u
  const footerH = 14 * u + footSize * 1.6 + pad * 0.8

  const height = headerH + graphH + legendH + footerH

  // ── 3. 像素倍数 ──
  const maxArea = isIOS() ? MAX_AREA_IOS : MAX_AREA
  const scale = Math.min(TARGET_SCALE, MAX_SIDE / Math.max(width, height), Math.sqrt(maxArea / (width * height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(width * scale)
  canvas.height = Math.floor(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('图太大，浏览器无法创建画布；可先筛选势力或进入中心视图后再导出')
  ctx.scale(scale, scale)
  ctx.lineJoin = 'round'

  ctx.fillStyle = p.canvas
  ctx.fillRect(0, 0, width, height)

  // ── 4. 页眉 ──
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  const title = fitText(ctx, `《${meta.bookTitle}》人物关系图`, innerW, 700, titleSize, p.serif)
  ctx.font = font(700, title.size, p.serif)
  ctx.fillStyle = p.ink
  ctx.fillText(title.text, pad, pad)
  const sub = fitText(ctx, [meta.scope, ...meta.view].join(' · '), innerW, 400, subSize, p.sans)
  ctx.font = font(400, sub.size, p.sans)
  ctx.fillStyle = p.muted
  ctx.fillText(sub.text, pad, pad + titleSize * 1.25 + 10 * u)

  // ── 5. 图：区块 → 连线 → 连线文字 → 人物 → 名字 ──
  ctx.save()
  ctx.translate((width - graphW) / 2 + GRAPH_MARGIN - bounds.x0, headerH + GRAPH_MARGIN - bounds.y0)
  drawGraph(ctx, scene, byId, comboRects, labelAt, p)
  ctx.restore()

  // ── 6. 图例 ──
  const legendTop = headerH + graphH
  ctx.strokeStyle = p.soft
  ctx.globalAlpha = 0.5
  ctx.lineWidth = 1
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(pad, legendTop)
  ctx.lineTo(width - pad, legendTop)
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.textBaseline = 'middle'
  for (const { it, x, row: r } of placedItems) {
    const y = legendTop + 14 * u + r * rowH + rowH / 2
    const x0 = pad + x
    let tx: number
    if (it.kind === 'line') {
      const line = LINE[it.hardness]
      ctx.strokeStyle = p[it.hardness]
      ctx.lineWidth = (it.width ?? line.width) * u
      ctx.setLineDash(line.dash.map((d) => d * u))
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(x0 + 2 * u, y)
      ctx.lineTo(x0 + swatchW - 2 * u, y)
      ctx.stroke()
      ctx.setLineDash([])
      tx = x0 + swatchW + 8 * u
    } else {
      ctx.fillStyle = it.color
      ctx.beginPath()
      ctx.arc(x0 + legendSize * 0.4, y, legendSize * 0.4, 0, Math.PI * 2)
      ctx.fill()
      tx = x0 + legendSize * 0.8 + 8 * u
    }
    const label = fitText(ctx, it.label, innerW - (tx - pad), 400, legendSize, p.sans)
    ctx.font = font(400, label.size, p.sans)
    ctx.fillStyle = p.ink2
    ctx.fillText(label.text, tx, y)
  }
  if (hint) {
    ctx.font = font(400, legendSize * 0.92, p.sans)
    ctx.fillStyle = p.muted
    ctx.fillText(hint, pad, legendTop + 14 * u + (row + 1) * rowH + rowH * 0.4)
  }

  // ── 7. 页脚：AI 生成说明 + 水印 ──
  const footY = height - pad * 0.8 - footSize * 0.8
  ctx.textBaseline = 'middle'
  ctx.font = font(400, footSize, p.sans)
  ctx.fillStyle = p.muted
  ctx.textAlign = 'left'
  ctx.fillText('由 AI 读原著自动生成，仅供参考', pad, footY)
  ctx.textAlign = 'right'
  ctx.font = font(700, footSize * 1.25, p.serif)
  ctx.fillStyle = p.ink2
  const brand = 'ZhiYing'
  ctx.fillText(brand, width - pad, footY)
  const brandW = ctx.measureText(brand).width
  ctx.font = font(700, footSize * 1.25, p.serif)
  ctx.fillStyle = p.ink
  ctx.fillText('织影 ', width - pad - brandW, footY)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('图片编码失败：图可能太大，可先筛选势力或进入中心视图后再导出')
  return { blob, width: canvas.width, height: canvas.height, scale }
}

function drawGraph(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  byId: Map<string, { n: SceneNode; x: number; y: number; r: number }>,
  comboRects: Map<string, Rect>,
  labelAt: Map<string, Pt>,
  p: Palette,
) {
  // 势力区块：浅底 + 淡虚线框 + 左上块名
  for (const c of scene.combos) {
    const r = comboRects.get(c.id)
    if (!r) continue
    const w = r.x1 - r.x0
    const h = r.y1 - r.y0
    ctx.beginPath()
    ctx.roundRect(r.x0, r.y0, w, h, Math.min(44, w / 2, h / 2))
    ctx.globalAlpha = 0.72
    ctx.fillStyle = p.factionSoft[c.slot]
    ctx.fill()
    ctx.globalAlpha = 0.3
    ctx.strokeStyle = p.faction[c.slot]
    ctx.lineWidth = 1.2
    ctx.setLineDash([4, 6])
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
    ctx.font = font(700, 14, p.serif)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillStyle = p.faction[c.slot]
    ctx.letterSpacing = '1px'
    ctx.fillText(c.name, r.x0 + 22, r.y0 + 14)
    ctx.letterSpacing = '0px'
  }

  // 连线：单章模式下本章依据加粗、压在上层，其余淡化
  const edges = [...scene.edges].sort((a, b) => Number(scene.focusSingle && a.inFocus) - Number(scene.focusSingle && b.inFocus))
  ctx.lineCap = 'round'
  for (const e of edges) {
    if (e.path.length < 2) continue
    const line = LINE[e.hardness]
    const now = scene.focusSingle && e.inFocus
    ctx.globalAlpha = scene.focusSingle && !e.inFocus ? 0.3 : 1
    ctx.strokeStyle = p[e.hardness]
    ctx.lineWidth = line.width + (now ? 1.6 : 0)
    ctx.setLineDash(line.dash)
    ctx.beginPath()
    ctx.moveTo(e.path[0].x, e.path[0].y)
    for (const pt of e.path.slice(1)) ctx.lineTo(pt.x, pt.y)
    ctx.stroke()
    // 有向关系的箭头，与画布一致：path 从 source（person_a 端）画到 target
    const { startArrow, endArrow } = edgeDirection(e.edge)
    if (startArrow || endArrow) {
      ctx.setLineDash([])
      ctx.fillStyle = p[e.hardness]
      if (endArrow) arrowHead(ctx, e.path, false)
      if (startArrow) arrowHead(ctx, e.path, true)
    }
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const e of edges) {
    const at = labelAt.get(e.id)
    if (!at) continue
    const now = scene.focusSingle && e.inFocus
    ctx.globalAlpha = scene.focusSingle && !e.inFocus ? 0.55 : 1
    ctx.font = font(now ? 600 : 400, EDGE_LABEL_FONT, p.sans)
    haloText(ctx, e.labelText, at.x, at.y, now ? p.ink : p.ink2, p.canvas)
  }
  ctx.globalAlpha = 1

  // 人物：势力浅底 + 势力色描边 + 首字；名字在下方
  for (const v of byId.values()) {
    const main = v.n.node.importance === 'main' || v.n.center
    ctx.beginPath()
    ctx.arc(v.x, v.y, v.r, 0, Math.PI * 2)
    ctx.fillStyle = p.factionSoft[v.n.slot]
    ctx.fill()
    ctx.strokeStyle = p.faction[v.n.slot]
    ctx.lineWidth = main ? 2.6 : 2
    ctx.stroke()
    ctx.font = font(700, Math.round(8 + v.r * 0.25), p.serif)
    ctx.textBaseline = 'middle'
    ctx.fillStyle = p.ink
    ctx.fillText(initialOf(v.n.node.name), v.x, v.y)
  }
  ctx.textBaseline = 'top'
  for (const v of byId.values()) {
    const main = v.n.node.importance === 'main' || v.n.center
    ctx.font = font(main ? 700 : 500, nameFontSize(v.n.node.importance), p.serif)
    haloText(ctx, v.n.node.name, v.x, v.y + v.r + 3, p.ink, p.canvas)
  }
}

/** 在路径末端（atStart 时为起端）画实心三角箭头，尺寸对应画布的 arrowSize 8 */
function arrowHead(ctx: CanvasRenderingContext2D, path: Pt[], atStart: boolean) {
  const size = 8
  const pts = atStart ? [...path].reverse() : path
  const tip = pts[pts.length - 1]
  // 取离尖端约一个箭头长的点定方向，弯曲线末端也不会歪
  let back = pts[0]
  for (let i = pts.length - 2; i >= 0; i--) {
    if (Math.hypot(tip.x - pts[i].x, tip.y - pts[i].y) >= size) { back = pts[i]; break }
  }
  const a = Math.atan2(tip.y - back.y, tip.x - back.x)
  const half = size * 0.5
  ctx.beginPath()
  ctx.moveTo(tip.x, tip.y)
  ctx.lineTo(tip.x - size * Math.cos(a) + half * Math.sin(a), tip.y - size * Math.sin(a) - half * Math.cos(a))
  ctx.lineTo(tip.x - size * Math.cos(a) - half * Math.sin(a), tip.y - size * Math.sin(a) + half * Math.cos(a))
  ctx.closePath()
  ctx.fill()
}

/** 带画布色描边的文字：压在连线上也读得清 */
function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, halo: string) {
  ctx.strokeStyle = halo
  ctx.lineWidth = 4
  ctx.lineJoin = 'round'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = fill
  ctx.fillText(text, x, y)
}

/** 下载文件名：书名 + 范围，去掉文件名里不允许的字符 */
export function pngFilename(bookTitle: string, scope: string): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 40)
  return `${clean(bookTitle) || '关系图'}-人物关系图-${clean(scope) || '全书'}.png`
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
