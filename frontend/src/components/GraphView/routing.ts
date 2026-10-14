/**
 * 为关系边选择可辨认的路径：优先直线；穿过沿途人物或与同一对人物的另一条线重叠时才曲线绕行。
 * 姓名只是软障碍：小弯能让开就让，否则保持直线，由 labels.ts 把姓名挪到没线的一侧。
 */
import type { SceneEdge, SceneNode } from './types'
import { boxAt, distance, expand, nameFontSize, overlaps, pathHitsBox, pathLength, segmentHitsBox, segmentsCross, sharedLength, textWidth, type Box, type Point } from './geometry'

import { sampleCurve } from './curveGeometry'

export function nodeObstacles(nodes: SceneNode[]): { owner: string; box: Box; name: boolean }[] {
  return nodes.flatMap((n) => [
    { owner: n.id, box: boxAt(n, n.r * 2 + 20, n.r * 2 + 20), name: false },
    { owner: n.id, box: boxAt({ x: n.x, y: n.y + n.r + 3 + nameFontSize(n.node.importance) / 2 }, textWidth(n.node.name, nameFontSize(n.node.importance)) + 16, nameFontSize(n.node.importance) + 14), name: true },
  ])
}

/** 与渲染端使用同一条平滑曲线，避免文字定位和避障检查偏离画出来的线。 */
function renderedPath(vertices: Point[], source: SceneNode, target: SceneNode): Point[] {
  const clip = (n: SceneNode, toward: Point): Point => {
    const len = distance(n, toward) || 1
    return { x: n.x + (toward.x - n.x) * n.r / len, y: n.y + (toward.y - n.y) * n.r / len }
  }
  const path = [...vertices]
  path[0] = clip(source, vertices[1])
  path[path.length - 1] = clip(target, vertices[vertices.length - 2])
  return sampleCurve(path)
}

/** 仅在简单绕行均被挡住时，沿障碍物角点寻找最短可见路径。 */
function visibilityRoute(a: Point, b: Point, boxes: Box[], clearance: number): Point[] | null {
  const corridor = expand({ x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) }, 200)
  const local = boxes.filter((box) => overlaps(corridor, box))
  const points = [a, b, ...local.flatMap((box) => [
    { x: box.x1 - clearance, y: box.y1 - clearance }, { x: box.x2 + clearance, y: box.y1 - clearance },
    { x: box.x1 - clearance, y: box.y2 + clearance }, { x: box.x2 + clearance, y: box.y2 + clearance },
  ]).filter((p) => !boxes.some((box) => p.x > box.x1 && p.x < box.x2 && p.y > box.y1 && p.y < box.y2))]
  const costs = points.map(() => Infinity), previous = points.map(() => -1), visited = new Set<number>()
  costs[0] = 0
  for (let step = 0; step < points.length; step++) {
    let best = -1
    for (let i = 0; i < points.length; i++) if (!visited.has(i) && (best < 0 || costs[i] < costs[best])) best = i
    if (best < 0 || !Number.isFinite(costs[best])) break
    if (best === 1) {
      const path = [b]
      for (let at = previous[1]; at >= 0; at = previous[at]) path.unshift(points[at])
      return path
    }
    visited.add(best)
    for (let i = 1; i < points.length; i++) {
      if (visited.has(i)) continue
      const cost = costs[best] + distance(points[best], points[i]) + 8
      if (cost >= costs[i] || boxes.some((box) => segmentHitsBox(points[best], points[i], box))) continue
      costs[i] = cost
      previous[i] = best
    }
  }
  return null
}

/** 压过一个别人的姓名，相当于多绕这么长的路：只值得用平缓的弯去换。 */
const NAME_COST = 60

export function routeEdges(nodes: SceneNode[], edges: SceneEdge[]): void {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const obstacles = nodeObstacles(nodes)
  const routed: { source: string; target: string; path: Point[] }[] = []
  // 先给重要关系留出直观路径；相同输入始终得到相同结果。
  const ordered = [...edges].sort((a, b) => ({ hard: 0, medium: 1, soft: 2 }[a.hardness] - { hard: 0, medium: 1, soft: 2 }[b.hardness]) || a.id.localeCompare(b.id))
  for (const edge of ordered) {
    const source = nodeMap.get(edge.source)!, target = nodeMap.get(edge.target)!
    const a = { x: source.x, y: source.y }, b = { x: target.x, y: target.y }
    // 端点自己的人物和姓名不算障碍：线总要连到人物上，姓名让线。
    const others = obstacles.filter((o) => o.owner !== source.id && o.owner !== target.id)
    const boxes = others.filter((o) => !o.name).map((o) => o.box)
    const nameBoxes = others.filter((o) => o.name).map((o) => o.box)
    // 只共用一个端点的线必然在端点附近靠拢，不算重叠；同一对人物的线才需要拆开。
    const parallel = routed.filter((r) => (r.source === source.id && r.target === target.id) || (r.source === target.id && r.target === source.id))
    const unrelated = routed.filter((r) => r.source !== source.id && r.source !== target.id && r.target !== source.id && r.target !== target.id)
    const len = distance(a, b) || 1, nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len
    const shift = (ratio: number, offset: number) => ({ x: a.x + (b.x - a.x) * ratio + nx * offset, y: a.y + (b.y - a.y) * ratio + ny * offset })
    let winner = [a, b], best = Infinity, winnerHits = Infinity, winnerClean = false
    const consider = (vertices: Point[]) => {
      const path = renderedPath(vertices, source, target)
      const hits = boxes.filter((box) => pathHitsBox(path, box)).length
      const nameHits = nameBoxes.filter((box) => pathHitsBox(path, box)).length
      // 按曲线自身衡量交叉和重叠，控制多边形不是屏幕上显示的路径。
      const skeleton = path.filter((_, i) => i === 0 || i === path.length - 1 || i % 6 === 0)
      let shared = 0, crossings = 0
      for (const prior of [...parallel, ...unrelated]) {
        for (let i = 1; i < skeleton.length; i++) for (let j = 1; j < prior.path.length; j++) {
          shared += sharedLength(skeleton[i - 1], skeleton[i], prior.path[j - 1], prior.path[j])
          if (segmentsCross(skeleton[i - 1], skeleton[i], prior.path[j - 1], prior.path[j])) crossings++
        }
      }
      const length = pathLength(path)
      const detour = Math.max(0, length - Math.max(1, len - source.r - target.r))
      // 交叉只用来在两侧之间挑一边，不为了少一个交叉把直线掰弯；共线分离采用小幅弯曲。
      const score = hits * 1000000 + nameHits * NAME_COST + shared * 16 + crossings * 4 + length + detour * 1.5 + detour * detour / len + (vertices.length - 2) * 8
      if (score < best) { best = score; winner = vertices; winnerHits = hits; winnerClean = !hits && !nameHits && !shared }
    }
    consider([a, b])
    // 直线可读时直接保留；遮挡或共线重叠时才尝试曲线。绕姓名的弯不超过线长的三分之一，穿过人物时才放开。
    if (!winnerClean) for (const offset of [-12, 12, -24, 24, -40, 40, -64, 64, -96, 96]) {
      if (!winnerHits && Math.abs(offset) > len / 3) break
      consider([a, shift(0.5, offset), b])
      const endpointRatio = Math.min(0.25, 48 / len)
      consider([a, shift(endpointRatio, offset), shift(1 - endpointRatio, offset), b])
    }
    if (winnerHits) for (const clearance of [20, 40, 72, 112]) {
      const detour = visibilityRoute(a, b, boxes, clearance)
      if (detour) consider(detour)
      if (!winnerHits) break
    }
    edge.controlPoints = winner.slice(1, -1)
    edge.path = renderedPath(winner, source, target)
    routed.push({ source: source.id, target: target.id, path: edge.path.filter((_, i) => i === 0 || i === edge.path.length - 1 || i % 6 === 0) })
  }
}
