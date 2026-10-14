/** 按当前缩放与交互态统一安排人物姓名和关系文字；放不下的文字由浮窗、详情承接。 */
import type { Focus, StyleCtx } from './style'
import type { Scene, SceneNode } from './types'
import { boxAt, EDGE_LABEL_FONT, nameFontSize, overlaps, pathHitsBox, pathPoint, textWidth, type Box } from './geometry'

/** overEdges：四周都有线时姓名压在线最少的一侧（靠描边保持可读），而不是藏掉。 */
export type NameLabel = { visible: boolean; placement: 'bottom' | 'top' | 'right' | 'left'; offsetX: number; offsetY: number; fontSize: number; box?: Box; overEdges?: boolean }
export type EdgeLabel = { visible: boolean; ratio: number; offsetY: number; fontSize: number; box?: Box }
export type LabelLayout = { names: Map<string, NameLabel>; edges: Map<string, EdgeLabel> }

function nameWanted(n: SceneNode, ctx: StyleCtx, focus: Focus): boolean {
  if (n.center || n.node.importance === 'main' || ctx.selectedNode === n.personId || focus.nodes.has(n.id)) return true
  return nameFontSize(n.node.importance) * ctx.zoom >= (n.node.importance === 'supporting' ? 6.5 : 9)
}

export function placeLabels(scene: Scene, ctx: StyleCtx, focus: Focus): LabelLayout {
  const names = new Map<string, NameLabel>(), edges = new Map<string, EdgeLabel>()
  const nodes = scene.nodes.map((n) => boxAt(n, n.r * 2 + 6, n.r * 2 + 6))
  const occupied: Box[] = [...nodes]
  const namePriority = (n: SceneNode) => Number(ctx.selectedNode === n.personId || ctx.hoverNode === n.id) * 10000 + Number(focus.nodes.has(n.id)) * 2000 + Number(n.center) * 1000 + ({ main: 300, supporting: 200, minor: 100 }[n.node.importance] ?? 100)
  for (const n of [...scene.nodes].sort((a, b) => namePriority(b) - namePriority(a) || a.id.localeCompare(b.id))) {
    const grow = n.node.importance === 'main' || n.center ? Math.min(2, Math.max(1, 0.75 / ctx.zoom)) : 1
    const fontSize = nameFontSize(n.node.importance) * grow
    const label: NameLabel = { visible: false, placement: 'bottom', offsetX: 0, offsetY: 8, fontSize }
    names.set(n.id, label)
    if (!nameWanted(n, ctx, focus)) continue
    const weight = n.node.importance === 'main' || n.center ? 700 : 500
    const width = textWidth(n.node.name, fontSize, ctx.palette.serif, weight)
    const gap = 8 * grow
    // 正下、正上、两侧，再试四个斜角（上 / 下方位横向挪开）：星形中心的正方位常被线占满。
    const dx = n.r * 0.7 + width / 2, dy = n.r * 0.7 + gap + fontSize / 2
    const candidates = [
      { placement: 'bottom' as const, x: n.x, y: n.y + n.r + gap + fontSize / 2, ox: 0, oy: gap },
      { placement: 'top' as const, x: n.x, y: n.y - n.r - gap - fontSize / 2, ox: 0, oy: -gap },
      { placement: 'right' as const, x: n.x + n.r + gap + width / 2, y: n.y, ox: gap, oy: 0 },
      { placement: 'left' as const, x: n.x - n.r - gap - width / 2, y: n.y, ox: -gap, oy: 0 },
      { placement: 'bottom' as const, x: n.x + dx, y: n.y + dy, ox: dx, oy: gap - n.r * 0.3 },
      { placement: 'bottom' as const, x: n.x - dx, y: n.y + dy, ox: -dx, oy: gap - n.r * 0.3 },
      { placement: 'top' as const, x: n.x + dx, y: n.y - dy, ox: dx, oy: n.r * 0.3 - gap },
      { placement: 'top' as const, x: n.x - dx, y: n.y - dy, ox: -dx, oy: n.r * 0.3 - gap },
    ]
    let pick: (typeof candidates)[number] | null = null, pickBox: Box | null = null, fewest = Infinity
    for (const c of candidates) {
      const box = boxAt(c, width + 8 * grow, fontSize + 6 * grow)
      if (occupied.some((b) => overlaps(b, box))) continue
      const crossed = scene.edges.filter((e) => pathHitsBox(e.path, box)).length
      if (crossed < fewest) { fewest = crossed; pick = c; pickBox = box }
      if (!crossed) break
    }
    if (pick && pickBox) {
      Object.assign(label, { visible: true, placement: pick.placement, offsetX: pick.ox, offsetY: pick.oy, box: pickBox, overEdges: fewest > 0 })
      occupied.push(pickBox)
    }
  }
  const priority = (id: string, hardness: string, inFocus: boolean) => Number(id === ctx.selectedEdge || id === ctx.hoverEdge) * 10000 + Number(focus.labelEdges.has(id)) * 2000 + Number(focus.selectedLabelEdges.has(id)) * 1000 + Number(scene.focusSingle && inFocus) * 300 + ({ hard: 30, medium: 20, soft: 10 }[hardness] ?? 0)
  for (const e of [...scene.edges].sort((a, b) => priority(b.id, b.hardness, b.inFocus) - priority(a.id, a.hardness, a.inFocus) || a.id.localeCompare(b.id))) {
    const related = focus.labelEdges.has(e.id)
    const selected = focus.selectedLabelEdges.has(e.id)
    const grow = related ? Math.min(2.2, Math.max(1, 0.8 / ctx.zoom)) : 1
    const fontSize = EDGE_LABEL_FONT * grow
    const label: EdgeLabel = { visible: false, ratio: 0.5, offsetY: 0, fontSize }
    edges.set(e.id, label)
    if (!e.labelText || fontSize * ctx.zoom < 7.5) continue
    if (!related && !selected && (focus.dimming || e.hardness === 'soft' || (scene.dense && ctx.zoom < 0.95))) continue
    const width = textWidth(e.labelText, fontSize, ctx.palette.sans, related || (scene.focusSingle && e.inFocus) ? 600 : 400)
    let placed = false
    for (const offsetY of [0, -(fontSize / 2 + 7), fontSize / 2 + 7]) {
      for (const ratio of [0.5, 0.38, 0.62, 0.28, 0.72, 0.2, 0.8]) {
        const p = pathPoint(e.path, ratio)
        const box = boxAt({ x: p.x, y: p.y + offsetY }, width + 8 * grow, fontSize + 6 * grow)
        if (occupied.some((b) => overlaps(b, box)) || scene.edges.some((other) => other.id !== e.id && pathHitsBox(other.path, box))) continue
        Object.assign(label, { visible: true, ratio, offsetY, box })
        occupied.push(box)
        placed = true
        break
      }
      if (placed) break
    }
  }
  return { names, edges }
}
