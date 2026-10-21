/**
 * 关系图布局的纯几何工具，与人物 / 势力语义无关：
 *
 * - 同心环槽位（ringSlots + assignSlots）：块内「核心人物居中、其余按亲疏分环」，
 *   每环能站几人按弧长反推（slots = 2πr / minChord），相邻节点弦长恒 ≥ minChord，不重叠；
 * - 矩形贪心装箱（packRects）：把各势力块当成矩形摆开，优先贴近与它连边多的块，互不重叠。
 */

export type Point = { x: number; y: number }

// ── 同心环 ──────────────────────────────────────────────

export type RingOpts = {
  /** 第一环半径（中心有核心人物时要让开它） */
  firstRadius: number
  /** 环间距 */
  ringGap: number
  /** 同环相邻节点最小弦长（节点直径 + 名字宽度 + 余量） */
  minChord: number
}

export type Ring = { radius: number; angles: number[] }

/**
 * 把 count 个点分进若干同心环：内环先满，最后一环按剩余人数均匀铺开。
 * 起始角错开半格，避免所有环都有一个点正对上方、把块名压住。
 */
export function ringSlots(count: number, opts: RingOpts): Ring[] {
  const rings: Ring[] = []
  let left = count
  let k = 0
  while (left > 0) {
    const radius = opts.firstRadius + k * opts.ringGap
    const cap = Math.max(3, Math.floor((Math.PI * 2 * radius) / opts.minChord))
    const m = Math.min(cap, left)
    const step = (Math.PI * 2) / m
    const start = -Math.PI / 2 + step / 2 + (k % 2 ? step / 2 : 0)
    rings.push({ radius, angles: Array.from({ length: m }, (_, i) => start + i * step) })
    left -= m
    k += 1
  }
  return rings
}

const angleDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % (Math.PI * 2)
  return d > Math.PI ? Math.PI * 2 - d : d
}

/**
 * 环上槽位分配：有方向偏好的人（例如连向东边另一块）先挑离偏好角最近的空槽，
 * 偏好越强越先挑；没偏好的人按原顺序补空位。返回与 items 同序的角度。
 */
export function assignSlots(
  angles: number[],
  prefs: ({ angle: number; weight: number } | null)[],
): number[] {
  const free = new Set(angles.map((_, i) => i))
  const out: number[] = new Array(prefs.length)
  const order = prefs
    .map((p, i) => ({ p, i }))
    .filter((x) => x.p)
    .sort((a, b) => b.p!.weight - a.p!.weight)
  for (const { p, i } of order) {
    let best = -1
    let bestD = Infinity
    for (const s of free) {
      const d = angleDiff(angles[s], p!.angle)
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    free.delete(best)
    out[i] = angles[best]
  }
  const rest = [...free].sort((a, b) => a - b)
  prefs.forEach((p, i) => {
    if (!p) out[i] = angles[rest.shift()!]
  })
  return out
}

// ── 矩形装箱 ──────────────────────────────────────────────

export type RectBox = {
  id: string
  w: number
  h: number
  /** 与其它块的连边权重，越大越想挨着 */
  links: Map<string, number>
}

/**
 * 贪心摆放矩形：第一个放原点，之后每个在已放矩形四周按 24 个方向试探，
 * 取「离有连边的块的加权重心近 + 离原点近」代价最小、且不与任何块重叠的位置。
 * aspect > 1 时纵向更贵，整体铺得更扁，贴合横向的画布。返回各矩形中心。
 */
export function packRects(
  boxes: RectBox[],
  opts: { margin: number; aspect: number },
): Map<string, Point> {
  const placed: { id: string; x: number; y: number; w: number; h: number }[] = []
  const out = new Map<string, Point>()
  const overlaps = (x: number, y: number, w: number, h: number) =>
    placed.some(
      (p) =>
        Math.abs(p.x - x) * 2 < p.w + w + opts.margin * 2 &&
        Math.abs(p.y - y) * 2 < p.h + h + opts.margin * 2,
    )
  const dist = (dx: number, dy: number) => Math.hypot(dx, dy * opts.aspect)

  for (const b of boxes) {
    if (!placed.length) {
      placed.push({ id: b.id, x: 0, y: 0, w: b.w, h: b.h })
      out.set(b.id, { x: 0, y: 0 })
      continue
    }
    let wx = 0
    let wy = 0
    let wsum = 0
    for (const p of placed) {
      const w = b.links.get(p.id) ?? 0
      if (w > 0) {
        wx += p.x * w
        wy += p.y * w
        wsum += w
      }
    }
    const target = wsum ? { x: wx / wsum, y: wy / wsum } : { x: 0, y: 0 }

    let best: Point | null = null
    let bestCost = Infinity
    for (const p of placed) {
      for (let k = 0; k < 24; k++) {
        const a = (Math.PI * 2 * k) / 24
        const ux = Math.cos(a)
        const uy = Math.sin(a)
        // 从刚好相切处向外步进，直到不重叠
        let d = Math.min(Math.abs((p.w + b.w) / 2 / (ux || 1e-9)), Math.abs((p.h + b.h) / 2 / (uy || 1e-9)))
        let x = p.x + ux * d
        let y = p.y + uy * d
        let guard = 0
        while (overlaps(x, y, b.w, b.h) && guard++ < 60) {
          d += 16
          x = p.x + ux * d
          y = p.y + uy * d
        }
        if (guard >= 60) continue
        const cost = dist(x - target.x, y - target.y) + 0.45 * dist(x, y)
        if (cost < bestCost) {
          bestCost = cost
          best = { x, y }
        }
      }
    }
    const pos = best ?? { x: 0, y: 0 }
    placed.push({ id: b.id, x: pos.x, y: pos.y, w: b.w, h: b.h })
    out.set(b.id, pos)
  }
  return out
}
