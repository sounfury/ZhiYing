/** 图谱共享几何：文字尺寸、矩形避让、连线路径采样与相交判断。 */
export type Point = { x: number; y: number }
export type Box = { x1: number; y1: number; x2: number; y2: number }
export const EDGE_LABEL_FONT = 11.5
export const nameFontSize = (importance: string) => importance === 'main' ? 15 : importance === 'supporting' ? 13 : 11.5
/** 亲疏档名字号：缩小时反向放大，画布与 PNG 导出（zoom=1）共用 */
export const ringLabelFont = (zoom: number) => 12 * Math.min(2.6, Math.max(1, 0.8 / zoom))

let context: CanvasRenderingContext2D | null = null
export function textWidth(text: string, size: number, family = 'serif', weight = 400): number {
  if (!context && typeof document !== 'undefined') context = document.createElement('canvas').getContext('2d')
  if (context) {
    context.font = `${weight} ${size}px ${family}`
    return context.measureText(text).width
  }
  return [...text].reduce((sum, c) => sum + (c.codePointAt(0)! <= 0xff ? 0.58 : 1), 0) * size
}
export function boxAt(p: Point, w: number, h: number): Box {
  return { x1: p.x - w / 2, y1: p.y - h / 2, x2: p.x + w / 2, y2: p.y + h / 2 }
}
export function expand(b: Box, pad: number): Box {
  return { x1: b.x1 - pad, y1: b.y1 - pad, x2: b.x2 + pad, y2: b.y2 + pad }
}
export function overlaps(a: Box, b: Box): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1
}
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
/** Liang–Barsky 裁剪；沿矩形边界通过视为不进入内部。 */
export function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
  if (Math.max(a.x, b.x) <= box.x1 || Math.min(a.x, b.x) >= box.x2 || Math.max(a.y, b.y) <= box.y1 || Math.min(a.y, b.y) >= box.y2) return false
  const inner = expand(box, -0.1)
  let lo = 0, hi = 1
  const dx = b.x - a.x, dy = b.y - a.y
  const constraints = [[-dx, a.x - inner.x1], [dx, inner.x2 - a.x], [-dy, a.y - inner.y1], [dy, inner.y2 - a.y]]
  for (const [p, q] of constraints) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return false; continue }
    const r = q / p
    if (p < 0) lo = Math.max(lo, r)
    else hi = Math.min(hi, r)
    if (lo > hi) return false
  }
  return hi > 0 && lo < 1
}
export function pathHitsBox(path: Point[], box: Box): boolean {
  for (let i = 1; i < path.length; i++) if (segmentHitsBox(path[i - 1], path[i], box)) return true
  return false
}
export function pathLength(path: Point[]): number {
  return path.slice(1).reduce((sum, p, i) => sum + distance(path[i], p), 0)
}
export function pathPoint(path: Point[], ratio: number): Point {
  let remaining = pathLength(path) * ratio
  for (let i = 1; i < path.length; i++) {
    const len = distance(path[i - 1], path[i])
    if (remaining <= len && len > 0) {
      const t = remaining / len
      return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t }
    }
    remaining -= len
  }
  return path[path.length - 1]
}
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
export function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  return cross(a, b, c) * cross(a, b, d) < -1e-6 && cross(c, d, a) * cross(c, d, b) < -1e-6
}
/** 相近且同向的路段共享了多少长度；普通交叉只在一点相遇，不算重叠。 */
export function sharedLength(a: Point, b: Point, c: Point, d: Point): number {
  if (Math.max(a.x, b.x) + 9 < Math.min(c.x, d.x) || Math.max(c.x, d.x) + 9 < Math.min(a.x, b.x) || Math.max(a.y, b.y) + 9 < Math.min(c.y, d.y) || Math.max(c.y, d.y) + 9 < Math.min(a.y, b.y)) return 0
  const len = distance(a, b), other = distance(c, d)
  if (!len || !other) return 0
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len
  const alignment = Math.abs(ux * (d.x - c.x) / other + uy * (d.y - c.y) / other)
  if (alignment < 0.985) return 0
  const normalC = Math.abs(ux * (c.y - a.y) - uy * (c.x - a.x))
  const normalD = Math.abs(ux * (d.y - a.y) - uy * (d.x - a.x))
  if (Math.max(normalC, normalD) > 9) return 0
  const t1 = ux * (c.x - a.x) + uy * (c.y - a.y), t2 = ux * (d.x - a.x) + uy * (d.y - a.y)
  return Math.max(0, Math.min(len, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2)))
}
