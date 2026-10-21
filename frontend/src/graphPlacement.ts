/** 势力块内人物位置的纯计算细化：同组同环换座、拓扑松弛及节点 / 名字避碰；不负责区块装箱、路由或连线标签。 */
import type { GraphEdge } from './api'
import type { Point } from './graphLayout'

export type PlacementNode = {
  id: string
  radius: number
  /** 名字实际或保守估算的完整宽高；名字居中放在节点下方。 */
  nameWidth: number
  nameHeight: number
  nameGap?: number
}

export type RefinePlacementInput = {
  positions: ReadonlyMap<string, Point>
  nodes: readonly PlacementNode[]
  edges: readonly Pick<GraphEdge, 'person_a' | 'person_b'>[]
  /** 只有同组人物换座、相互吸引；跨组边由路由层处理。 */
  groups: ReadonlyMap<string, string>
  /** 固定在输入坐标；势力块逐块调用时传核心人物。 */
  fixedCenter?: string | null
}

type Box = { left: number; top: number; right: number; bottom: number }
type Item = PlacementNode & { seed: Point; point: Point; group: string; fixed: boolean }
type Link = { a: Item; b: Item }
const GAP = 8
const RELAX_STEPS = 80
const SWAP_BUDGET = 256
// 总几何工作量也限额，避免大图 / 稠密图在主线程跑满所有迭代。
const SWAP_WORK = 300000
const RELAX_WORK = 600000
const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function footprints(n: PlacementNode, p: Point): Box[] {
  const r = n.radius + 2
  const boxes = [{ left: p.x - r, top: p.y - r, right: p.x + r, bottom: p.y + r }]
  if (n.nameWidth > 0 && n.nameHeight > 0) {
    const top = p.y + n.radius + (n.nameGap ?? 3)
    boxes.push({ left: p.x - n.nameWidth / 2 - 3, top, right: p.x + n.nameWidth / 2 + 3, bottom: top + n.nameHeight + 3 })
  }
  return boxes
}

function overlap(a: Box, b: Box): Point | null {
  const x = Math.min(a.right, b.right) - Math.max(a.left, b.left) + GAP
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) + GAP
  return x > 0 && y > 0 ? { x, y } : null
}

function constrain(item: Item, p: Point): Point {
  return item.fixed ? { ...item.seed } : p
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function crosses(a: Link, b: Link): boolean {
  if (a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b) return false
  return cross(a.a.point, a.b.point, b.a.point) * cross(a.a.point, a.b.point, b.b.point) < -1e-6 &&
    cross(b.a.point, b.b.point, a.a.point) * cross(b.a.point, b.b.point, a.b.point) < -1e-6
}

/** 线段与扩展矩形的内部相交，包含共线遮挡，但不把共用端点当成遮挡。 */
function through(a: Point, b: Point, box: Box): boolean {
  let lo = 0
  let hi = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  const left = box.left - GAP / 2
  const right = box.right + GAP / 2
  const top = box.top - GAP / 2
  const bottom = box.bottom + GAP / 2
  if (Math.abs(dx) < 1e-9) {
    if (a.x <= left || a.x >= right) return false
  } else {
    const t1 = (left - a.x) / dx
    const t2 = (right - a.x) / dx
    lo = Math.max(lo, Math.min(t1, t2))
    hi = Math.min(hi, Math.max(t1, t2))
  }
  if (Math.abs(dy) < 1e-9) {
    if (a.y <= top || a.y >= bottom) return false
  } else {
    const t1 = (top - a.y) / dy
    const t2 = (bottom - a.y) / dy
    lo = Math.max(lo, Math.min(t1, t2))
    hi = Math.min(hi, Math.max(t1, t2))
  }
  return lo < hi && hi > 0 && lo < 1
}

function cost(items: Item[], links: Link[]): number {
  const boxes = items.map((n) => footprints(n, n.point))
  let value = 0
  for (let i = 0; i < items.length; i++) {
    const n = items[i]
    value += 0.015 * ((n.point.x - n.seed.x) ** 2 + (n.point.y - n.seed.y) ** 2)
    for (let j = i + 1; j < items.length; j++) {
      for (const a of boxes[i]) for (const b of boxes[j]) {
        const d = overlap(a, b)
        if (d) value += 100000 + 50 * Math.min(d.x, d.y) ** 2
      }
    }
  }
  for (let i = 0; i < links.length; i++) {
    const e = links[i]
    value += 0.02 * ((e.a.point.x - e.b.point.x) ** 2 + (e.a.point.y - e.b.point.y) ** 2)
    for (let j = i + 1; j < links.length; j++) if (crosses(e, links[j])) value += 20000
    for (let j = 0; j < items.length; j++) {
      if (items[j] === e.a || items[j] === e.b) continue
      if (boxes[j].some((b) => through(e.a.point, e.b.point, b))) value += 12000
    }
  }
  return value
}

/** 只交换同组、近似同半径的座位，不把远亲换进内环。 */
function reorder(items: Item[], links: Link[]) {
  const groups = new Map<string, Item[]>()
  for (const n of items) {
    if (!groups.has(n.group)) groups.set(n.group, [])
    groups.get(n.group)!.push(n)
  }
  for (const members of groups.values()) {
    if (members.length < 3) continue
    const fixed = members.find((n) => n.fixed)
    const origin = fixed?.seed ?? {
      x: members.reduce((s, n) => s + n.seed.x, 0) / members.length,
      y: members.reduce((s, n) => s + n.seed.y, 0) / members.length,
    }
    const radius = (n: Item) => Math.hypot(n.seed.x - origin.x, n.seed.y - origin.y)
    const localLinks = links.filter((e) => e.a.group === members[0].group)
    const work = members.length ** 2 + localLinks.length ** 2 + members.length * localLinks.length
    const budget = Math.min(SWAP_BUDGET, Math.floor(SWAP_WORK / work))
    if (!budget) continue
    let best = cost(members, localLinks)
    let tries = 0
    for (let pass = 0; pass < 3 && tries < budget; pass++) {
      let changed = false
      for (let i = 0; i < members.length && tries < budget; i++) {
        for (let j = i + 1; j < members.length && tries < budget; j++) {
          const a = members[i]
          const b = members[j]
          if (a.fixed || b.fixed || Math.abs(radius(a) - radius(b)) > 24) continue
          const pa = a.point
          const pb = b.point
          tries++
          a.point = { ...pb }
          b.point = { ...pa }
          const next = cost(members, localLinks)
          if (next < best - 1e-6) {
            best = next
            changed = true
          } else {
            a.point = pa
            b.point = pb
          }
        }
      }
      if (!changed) break
    }
  }
}

function separate(items: Item[]) {
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i]
    const b = items[j]
    if (a.fixed && b.fixed) continue
    let aBoxes = footprints(a, a.point)
    let bBoxes = footprints(b, b.point)
    for (let ai = 0; ai < aBoxes.length; ai++) {
      for (let bi = 0; bi < bBoxes.length; bi++) {
        const ab = aBoxes[ai]
        const bb = bBoxes[bi]
        const d = overlap(ab, bb)
        if (!d) continue
        const horizontal = d.x < d.y
        const sign = horizontal ? (ab.left + ab.right <= bb.left + bb.right ? -1 : 1) : (ab.top + ab.bottom <= bb.top + bb.bottom ? -1 : 1)
        const shift = sign * ((horizontal ? d.x : d.y) + 0.5)
        const dx = horizontal ? shift : 0
        const dy = horizontal ? 0 : shift
        const share = a.fixed ? 0 : b.fixed ? 1 : 0.5
        a.point = constrain(a, { x: a.point.x + dx * share, y: a.point.y + dy * share })
        b.point = constrain(b, { x: b.point.x - dx * (1 - share), y: b.point.y - dy * (1 - share) })
        aBoxes = footprints(a, a.point)
        bBoxes = footprints(b, b.point)
      }
    }
  }
}

function relax(items: Item[], links: Link[]) {
  const index = new Map(items.map((n, i) => [n, i]))
  let best = cost(items, links)
  let saved = items.map((n) => ({ ...n.point }))
  const work = items.length ** 2 + items.length * links.length + links.length ** 2
  const steps = Math.max(8, Math.min(RELAX_STEPS, Math.floor(RELAX_WORK / work)))
  for (let step = 0; step < steps; step++) {
    const forces = items.map((n) => ({ x: (n.seed.x - n.point.x) * 0.025, y: (n.seed.y - n.point.y) * 0.025 }))
    const add = (n: Item, x: number, y: number) => {
      const f = forces[index.get(n)!]
      f.x += x
      f.y += y
    }
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      const dx = a.point.x - b.point.x
      const dy = a.point.y - b.point.y
      const d = Math.hypot(dx, dy)
      if (d < 1e-6) continue // 重合点由矩形投影确定性分开。
      const push = Math.min(2, 2400 / (d * d))
      add(a, (dx / d) * push, (dy / d) * push)
      add(b, (-dx / d) * push, (-dy / d) * push)
    }
    const boxes = new Map(items.map((n) => [n, footprints(n, n.point)]))
    for (const e of links) {
      const dx = e.b.point.x - e.a.point.x
      const dy = e.b.point.y - e.a.point.y
      const d = Math.hypot(dx, dy)
      if (d < 1e-6) continue
      const pull = (d - Math.max(100, e.a.radius + e.b.radius + 50)) * 0.035
      add(e.a, (dx / d) * pull, (dy / d) * pull)
      add(e.b, (-dx / d) * pull, (-dy / d) * pull)
      const nx = -dy / d
      const ny = dx / d
      for (const n of items) {
        if (n === e.a || n === e.b) continue
        for (const box of boxes.get(n)!) {
          if (!through(e.a.point, e.b.point, box)) continue
          const cx = (box.left + box.right) / 2
          const cy = (box.top + box.bottom) / 2
          const side = (cx - e.a.point.x) * nx + (cy - e.a.point.y) * ny
          const half = Math.abs(nx) * (box.right - box.left) / 2 + Math.abs(ny) * (box.bottom - box.top) / 2
          // 完全共线也要选定一侧，否则三角形永远不能展开。
          const sign = Math.abs(side) > 1e-6 ? Math.sign(side) : (compareId(n.id, e.a.id) < 0 ? -1 : 1)
          const push = sign * Math.min(10, Math.max(2, (half + GAP - Math.abs(side)) * 0.35))
          add(n, nx * push, ny * push)
          add(e.a, -nx * push / 4, -ny * push / 4)
          add(e.b, -nx * push / 4, -ny * push / 4)
        }
      }
    }
    items.forEach((n, i) => {
      const f = forces[i]
      const scale = Math.min(1, 10 / (Math.hypot(f.x, f.y) || 1))
      n.point = constrain(n, { x: n.point.x + f.x * scale, y: n.point.y + f.y * scale })
    })
    separate(items)
    if (step % 8 === 7 || step === steps - 1) {
      const next = cost(items, links)
      if (next < best) {
        best = next
        saved = items.map((n) => ({ ...n.point }))
      }
    }
  }
  items.forEach((n, i) => { n.point = saved[i] })
}

/** 剩余的接触逐个修复；至少存在一个外侧候选，长名字无需无限迭代。 */
function clearRemaining(items: Item[]) {
  const placed: Item[] = []
  const order = [...items].sort((a, b) => Number(b.fixed) - Number(a.fixed) || compareId(a.id, b.id))
  for (const n of order) {
    const occupied = placed.flatMap((p) => footprints(p, p.point))
    const clear = (p: Point) => footprints(n, p).every((a) => occupied.every((b) => !overlap(a, b)))
    if (!n.fixed && !clear(n.point)) {
      const original = n.point
      const own = footprints(n, original)
      const candidates: Point[] = []
      for (const a of own) for (const b of occupied) {
        candidates.push(
          { x: original.x + b.left - a.right - GAP - 1, y: original.y },
          { x: original.x + b.right - a.left + GAP + 1, y: original.y },
          { x: original.x, y: original.y + b.top - a.bottom - GAP - 1 },
          { x: original.x, y: original.y + b.bottom - a.top + GAP + 1 },
        )
      }
      let best = Infinity
      for (const candidate of candidates) {
        const p = constrain(n, candidate)
        const distance = (p.x - original.x) ** 2 + (p.y - original.y) ** 2
        if (distance < best && clear(p)) {
          best = distance
          n.point = p
        }
      }
    }
    placed.push(n)
  }
}

/**
 * 有限、确定性的细化，输入不变，返回新 Map / Point；节点必须有有限输入坐标和非负尺寸。
 * 势力布局：每块在局部坐标中单独调用（固定 hub），随后按实际节点 + 名字边界装箱。
 * 多块不能以重叠的局部坐标同时调用；装箱后的块也不能沿用细化前的包围盒。
 * 清除全部足迹碰撞。
 */
export function refinePlacement(input: RefinePlacementInput): Map<string, Point> {
  const out = new Map([...input.positions].map(([id, p]) => [id, { ...p }]))
  const items: Item[] = [...input.nodes]
    .sort((a, b) => compareId(a.id, b.id))
    .filter((n) => out.has(n.id))
    .map((n) => ({ ...n, seed: { ...out.get(n.id)! }, point: { ...out.get(n.id)! }, group: input.groups.get(n.id) ?? n.id, fixed: n.id === input.fixedCenter }))
  const byId = new Map(items.map((n) => [n.id, n]))
  const pairs = new Map<string, Link>()
  for (const edge of input.edges) {
    const [aId, bId] = [edge.person_a, edge.person_b].sort(compareId)
    const a = byId.get(aId)
    const b = byId.get(bId)
    if (a && b && a !== b && a.group === b.group) pairs.set(JSON.stringify([aId, bId]), { a, b })
  }
  const links = [...pairs.entries()].sort(([a], [b]) => compareId(a, b)).map(([, e]) => e)
  if (items.length > 1) {
    reorder(items, links)
    relax(items, links)
    clearRemaining(items)
  }
  for (const n of items) out.set(n.id, { ...n.point })
  return out
}
