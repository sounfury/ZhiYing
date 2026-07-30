/**
 * 极坐标楔形装填 —— 两种布局模式共用的几何底座。
 *
 * 核心保证：**相邻节点弦长恒 ≥ minChord，所以永不重叠**。
 * 做法是不预设每环放几个人，而是按可用弧长反推槽位数：
 *
 *     slots(r) = floor(楔形张角 * r / minChord)
 *
 * 半径越大一环能站的人越多；一环装不下就向外开新环。
 * 图会变大（节点多时直径可到几千 px），但缩放后始终可读——
 * 这比「固定半径 + 硬塞」再靠 fitView 缩小要好得多。
 */

export type PolarPos = {
  x: number
  y: number
  r: number
  angle: number
}

export type Wedge = {
  /** 楔形起止角（弧度） */
  a0: number
  a1: number
  /** 中线角，画势力名用 */
  mid: number
  /** 最内 / 最外环半径 */
  baseRadius: number
  outerRadius: number
  rings: number
}

export type Bucket = {
  id: string
  /** 已按调用方语义排好序：越靠前越靠内环 */
  ids: string[]
}

export type PackOpts = {
  cx: number
  cy: number
  /** 相邻节点最小弦长（节点直径 + 名字宽度 + 余量） */
  minChord: number
  /** 环间距（节点直径 + 标签高度 + 余量） */
  ringGap: number
  /** 楔形之间的角度缝 */
  wedgeGap: number
  /** 每块起始半径；不给则统一用 innerRadius */
  baseRadiusOf?: (bucketId: string, index: number) => number
  innerRadius: number
  /** 单块最小张角，避免只有 1-2 人的块被压成一条线 */
  minWedgeSpan?: number
}

const MAX_RINGS = 40

/**
 * 在 [a0, a1] 楔形内从 baseRadius 起向外分环装填。
 *
 * 每环节点按「格心」摆（angle = a0 + span*(i+0.5)/m），
 * 天然离楔形缝有半格距离，相邻块不会贴在一起。
 */
export function fillWedge(
  ids: string[],
  a0: number,
  a1: number,
  baseRadius: number,
  opts: Pick<PackOpts, 'cx' | 'cy' | 'minChord' | 'ringGap'>,
): { pos: Map<string, PolarPos>; outerRadius: number; rings: number } {
  const pos = new Map<string, PolarPos>()
  const span = Math.max(a1 - a0, 1e-3)
  if (!ids.length) return { pos, outerRadius: baseRadius, rings: 0 }

  const rings: string[][] = []
  let cursor = 0
  while (cursor < ids.length && rings.length < MAX_RINGS) {
    const r = baseRadius + rings.length * opts.ringGap
    const slots = Math.max(1, Math.floor((span * r) / opts.minChord))
    rings.push(ids.slice(cursor, cursor + slots))
    cursor += slots
  }
  // 兜底：极端情况下把剩余的人塞进最后一环（宁可挤，不要丢人）
  if (cursor < ids.length) rings[rings.length - 1].push(...ids.slice(cursor))

  rings.forEach((ringIds, ringIdx) => {
    const r = baseRadius + ringIdx * opts.ringGap
    const m = ringIds.length
    ringIds.forEach((id, i) => {
      const angle = m === 1 ? a0 + span / 2 : a0 + (span * (i + 0.5)) / m
      pos.set(id, {
        x: opts.cx + r * Math.cos(angle),
        y: opts.cy + r * Math.sin(angle),
        r,
        angle,
      })
    })
  })

  return {
    pos,
    outerRadius: baseRadius + (rings.length - 1) * opts.ringGap,
    rings: rings.length,
  }
}

/**
 * 把若干块摆成一圈楔形：张角按人数分配（带最小底角），块内交给 fillWedge。
 *
 * 返回每块的楔形几何，供调用方画势力名 / 底色。
 */
export function packWedges(
  buckets: Bucket[],
  opts: PackOpts,
): { pos: Map<string, PolarPos>; wedges: Map<string, Wedge>; outerRadius: number } {
  const pos = new Map<string, PolarPos>()
  const wedges = new Map<string, Wedge>()
  const active = buckets.filter((b) => b.ids.length > 0)
  if (!active.length) return { pos, wedges, outerRadius: opts.innerRadius }

  const k = active.length
  const gapTotal = opts.wedgeGap * k
  const usable = Math.max(Math.PI * 2 - gapTotal, Math.PI / 2)
  const total = active.reduce((s, b) => s + b.ids.length, 0)

  // 底角 + 按人数分配剩余，保证 1 人块也有可见张角
  const base = Math.min(opts.minWedgeSpan ?? 0.22, usable / (2 * k))
  const spare = Math.max(usable - base * k, 0)

  let cursor = -Math.PI / 2
  let maxOuter = opts.innerRadius

  active.forEach((b, idx) => {
    const span = base + (spare * b.ids.length) / total
    const a0 = cursor
    const a1 = cursor + span
    const baseRadius = opts.baseRadiusOf?.(b.id, idx) ?? opts.innerRadius
    const filled = fillWedge(b.ids, a0, a1, baseRadius, opts)
    filled.pos.forEach((p, id) => pos.set(id, p))
    wedges.set(b.id, {
      a0,
      a1,
      mid: a0 + span / 2,
      baseRadius,
      outerRadius: filled.outerRadius,
      rings: filled.rings,
    })
    maxOuter = Math.max(maxOuter, filled.outerRadius)
    cursor = a1 + opts.wedgeGap
  })

  return { pos, wedges, outerRadius: maxOuter }
}
