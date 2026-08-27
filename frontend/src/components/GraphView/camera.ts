import type { Graph } from '@antv/g6'

/** 搜索命中后的镜头推进 */
export const FOCUS = {
  /** 一段式推进的时长 */
  duration: 520,
  /** 目标缩放：百人大图 fitView 后通常只有 0.3 左右，推到这个级别才看得清名字 */
  zoom: 1.05,
}

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

/**
 * 把镜头推到某个世界坐标 + 目标缩放，自己按帧算缓动。
 *
 * 为什么不用 G6 的 focusElement / zoomTo 动画（三个坑叠在一起，合起来就是「特别卡」）：
 *  1. 建图传了 animation: false，G6 会把视口动画一并关掉——getAnimationOptions 见到
 *     options.animation === false 就直接返回 false，逐次调用传的 duration/easing 被
 *     静默丢弃，镜头是硬切的；
 *  2. 平移和推近是两次 viewport.transform，后一次的 gotoLandmark 会掐掉前一次的动画；
 *  3. 即使只发一次，G6 的 landmark 每帧是 lerp(当前值, 目标值, ease(t))——从「当前」
 *     而不是「起点」插值，等于指数逼近：前小半段就冲到位、后半段几乎不动、最后一帧硬切。
 *
 * 所以自己驱动一个 rAF：平移与缩放同一条时间轴，缩放走几何插值（等比变化才是匀速的
 * 观感），每帧用非动画的 zoomTo + translateTo 落到画布上（两次调用同步生效，合成一帧）。
 */
export function dollyTo(
  graph: Graph,
  container: HTMLElement,
  target: [number, number],
  targetZoom: number,
  duration: number,
): () => void {
  const [cx, cy] = graph.getCanvasCenter()
  const [fx, fy] = graph.getViewportCenter()
  const [tx, ty] = target
  const z0 = graph.getZoom()
  const zRatio = targetZoom / z0

  // 已经对准且够近：别为了播动画白刷 500ms 的帧
  if (Math.abs(zRatio - 1) < 0.01 && Math.hypot(tx - fx, ty - fy) < 1) {
    return () => {}
  }

  let raf = 0
  let stopped = false

  const stop = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(raf)
    container.removeEventListener('wheel', stop)
    container.removeEventListener('pointerdown', stop)
  }

  // 动画途中用户自己拖 / 滚：立刻让位，否则每帧都把用户的操作覆盖回去，那才是真卡
  container.addEventListener('wheel', stop, { passive: true })
  container.addEventListener('pointerdown', stop)

  let startTs = 0
  const step = (now: number) => {
    if (stopped) return
    if (!startTs) startTs = now
    const t = Math.min(1, (now - startTs) / duration)
    const u = easeInOutCubic(t)

    const zoom = z0 * Math.pow(zRatio, u)
    const px = fx + (tx - fx) * u
    const py = fy + (ty - fy) * u
    // translateTo 收的是屏幕位移，按当前缩放折算回世界坐标（见 ViewportController）
    void graph.zoomTo(zoom, false)
    void graph.translateTo([(cx - px) * zoom, (cy - py) * zoom], false)

    if (t < 1) raf = requestAnimationFrame(step)
    else stop()
  }
  raf = requestAnimationFrame(step)

  return stop
}
