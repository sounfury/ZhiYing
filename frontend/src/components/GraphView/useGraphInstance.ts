/**
 * G6 实例生命周期：建图 / 销毁、交互（单击选中、双击进中心视图、悬停高亮）、样式重算、镜头（适应窗口、放大缩小、搜索推进）、容器尺寸。
 *
 * 关键约束：只有场景（数据 / 视图范围 / 中心人物 / 布局）变了才重建图；选人、悬停、切主题、缩放、点按钮
 * 都只是重算样式后增量 updateData + draw，不重建、不重置视角。为此回调一律存 ref，建图 effect 只依赖 scene。
 */
import { useEffect, useRef, type RefObject } from 'react'
import { Graph, type IPointerEvent } from '@antv/g6'
import type { GraphEdge, GraphNode } from '../../api'
import type { FocusRequest, Scene, ZoomRequest } from './types'
import { FOCUS, dollyTo, fitPadding } from './camera'
import {
  comboStyle,
  computeFocus,
  edgeStyle,
  nodeStyle,
  readPalette,
  type Palette,
  type StyleCtx,
} from './style'

/** 悬停浮卡的内容与位置（相对图容器） */
export type HoverInfo =
  | { kind: 'node'; node: GraphNode; x: number; y: number }
  | { kind: 'edge'; edge: GraphEdge; x: number; y: number }

type Args = {
  containerRef: RefObject<HTMLDivElement | null>
  scene: Scene | null
  selectedPersonId: string | null
  /** 选中连线的场景 id（e:a|b） */
  selectedEdgeId: string | null
  focusRequest: FocusRequest | null
  zoomRequest: ZoomRequest | null
  refitToken: number
  onSelectEdge?: (edge: GraphEdge | null) => void
  onSelectNode?: (node: GraphNode | null) => void
  onEnterEgo?: (personId: string) => void
  onHover?: (info: HoverInfo | null) => void
}

/** 适应窗口后最多放到这么大：两三个人的小图别被放成巨型气泡 */
const MAX_FIT_ZOOM = 1.15
const ZOOM_STEP = 1.3

export function useGraphInstance({
  containerRef,
  scene,
  selectedPersonId,
  selectedEdgeId,
  focusRequest,
  zoomRequest,
  refitToken,
  onSelectEdge,
  onSelectNode,
  onEnterEgo,
  onHover,
}: Args) {
  const graphRef = useRef<Graph | null>(null)
  const sceneRef = useRef<Scene | null>(null)
  /** 当前图「画完并框好」的时刻；选中、镜头、重算样式都等它落定再动手 */
  const readyRef = useRef<Promise<void>>(Promise.resolve())
  /** 在飞的镜头推进的取消句柄：容器尺寸一变，它捕获的画布中心就过期了 */
  const dollyCancelRef = useRef<(() => void) | null>(null)

  // 回调存 ref：调用方常传内联箭头函数，放进建图依赖会让任何状态变化都重建图
  const cb = useRef({ onSelectEdge, onSelectNode, onEnterEgo, onHover })
  cb.current = { onSelectEdge, onSelectNode, onEnterEgo, onHover }

  // 交互态存 ref：变化时只重算样式
  const paletteRef = useRef<Palette | null>(null)
  const hoverNodeRef = useRef<string | null>(null)
  const hoverEdgeRef = useRef<string | null>(null)
  const selectedNodeRef = useRef<string | null>(selectedPersonId)
  const selectedEdgeRef = useRef<string | null>(selectedEdgeId)
  /** 上次推给 G6 的样式（JSON），只推变了的元素 */
  const appliedRef = useRef(new Map<string, string>())
  const rafRef = useRef(0)

  const restyleNow = (force = false) => {
    const g = graphRef.current
    const sc = sceneRef.current
    if (!g || !sc || g.destroyed) return
    if (!paletteRef.current) paletteRef.current = readPalette()
    const ctx: StyleCtx = {
      palette: paletteRef.current,
      zoom: g.getZoom(),
      hoverNode: hoverNodeRef.current,
      hoverEdge: hoverEdgeRef.current,
      selectedNode: selectedNodeRef.current,
      selectedEdge: selectedEdgeRef.current,
    }
    const focus = computeFocus(sc, ctx)
    const applied = appliedRef.current
    const changed = <T extends { id: string }>(id: string, style: Record<string, unknown>, out: T[], make: () => T) => {
      const key = JSON.stringify(style)
      if (!force && applied.get(id) === key) return
      applied.set(id, key)
      out.push(make())
    }
    const nodes: { id: string; style: Record<string, unknown> }[] = []
    const edges: { id: string; style: Record<string, unknown> }[] = []
    const combos: { id: string; style: Record<string, unknown> }[] = []
    for (const n of sc.nodes) {
      const style = nodeStyle(n, ctx, focus)
      changed(n.id, style, nodes, () => ({ id: n.id, style }))
    }
    for (const e of sc.edges) {
      const style = edgeStyle(e, sc, ctx, focus)
      changed(e.id, style, edges, () => ({ id: e.id, style }))
    }
    for (const c of sc.combos) {
      const style = comboStyle(c, ctx, focus)
      changed(`combo:${c.id}`, style, combos, () => ({ id: c.id, style }))
    }
    if (!nodes.length && !edges.length && !combos.length) return
    try {
      g.updateData({ nodes, edges, combos })
      void g.draw().catch(() => {})
    } catch {
      /* 图可能正在销毁 */
    }
  }
  const restyleRef = useRef(restyleNow)
  restyleRef.current = restyleNow

  /** 合并到下一帧重算（悬停 / 缩放会连发） */
  const scheduleRef = useRef((force = false) => {
    if (force) appliedRef.current.clear()
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      void readyRef.current.then(() => restyleRef.current())
    })
  })
  const schedule = scheduleRef.current

  /** 适应窗口：避开图上的悬浮工具条，小图不放得过大 */
  const fitRef = useRef(async (g: Graph) => {
    const container = containerRef.current
    if (!container || g.destroyed) return
    const padding = fitPadding(container)
    g.setOptions({ padding })
    await g.fitView({ when: 'always', direction: 'both' })
    if (g.getZoom() > MAX_FIT_ZOOM) {
      // 以留白后的可视区中心为原点缩回，图仍居中在悬浮件之间
      const [top, right, bottom, left] = padding
      const [w, h] = g.getSize()
      await g.zoomTo(MAX_FIT_ZOOM, false, [left + (w - left - right) / 2, top + (h - top - bottom) / 2])
    }
  })

  // ── 建图：只依赖 scene ──
  useEffect(() => {
    const container = containerRef.current
    if (!container || !scene) return

    graphRef.current?.destroy()
    graphRef.current = null
    sceneRef.current = scene
    appliedRef.current = new Map()
    hoverNodeRef.current = null
    hoverEdgeRef.current = null
    if (!paletteRef.current) paletteRef.current = readPalette()

    const ctx: StyleCtx = {
      palette: paletteRef.current,
      zoom: 1,
      hoverNode: null,
      hoverEdge: null,
      selectedNode: selectedNodeRef.current,
      selectedEdge: selectedEdgeRef.current,
    }
    const focus = computeFocus(scene, ctx)
    const nodeById = new Map(scene.nodes.map((n) => [n.id, n]))
    const edgeById = new Map(scene.edges.map((e) => [e.id, e]))

    const graph = new Graph({
      container,
      width: container.clientWidth || 800,
      height: container.clientHeight || 560,
      animation: false,
      zoomRange: [0.08, 4],
      data: {
        nodes: scene.nodes.map((n) => ({
          id: n.id,
          combo: n.combo ?? null,
          style: { x: n.x, y: n.y, ...nodeStyle(n, ctx, focus) },
        })),
        edges: scene.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          style: edgeStyle(e, scene, ctx, focus),
        })),
        combos: scene.combos.map((c) => ({ id: c.id, style: comboStyle(c, ctx, focus) })),
      },
      node: { type: 'circle' },
      edge: { type: 'line' },
      combo: { type: 'rect' },
      behaviors: [
        // 势力区块铺满大半画布，只允许在空白处拖动会很难用：区块上也能拖
        {
          type: 'drag-canvas',
          key: 'drag-canvas',
          enable: (e: IPointerEvent) => e.targetType === 'canvas' || e.targetType === 'combo',
        },
        { type: 'zoom-canvas', key: 'zoom-canvas' },
        // 人物可拖（PRD §5.7.2）；放下不改区块归属
        {
          type: 'drag-element',
          key: 'drag-element',
          enable: (e: IPointerEvent) => e.targetType === 'node',
          dropEffect: 'none',
        },
      ],
    })

    const idOf = (evt: unknown) => (evt as { target?: { id?: string } }).target?.id
    const local = (evt: unknown) => {
      const client = (evt as { client?: { x: number; y: number } }).client
      const rect = container.getBoundingClientRect()
      return client ? { x: client.x - rect.left, y: client.y - rect.top } : { x: 0, y: 0 }
    }
    // 拖动画布（含在势力区块上拖）松手时也会冒出 click，只有没怎么移动的才算「点空白取消选中」
    let down = { x: 0, y: 0 }
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY }
    }
    container.addEventListener('pointerdown', onDown, true)
    const clear = (evt: unknown) => {
      const client = (evt as { client?: { x: number; y: number } }).client
      if (client && Math.hypot(client.x - down.x, client.y - down.y) > 4) return
      cb.current.onSelectEdge?.(null)
      cb.current.onSelectNode?.(null)
    }

    graph.on('node:click', (evt: unknown) => {
      const n = nodeById.get(idOf(evt) ?? '')
      if (!n) return
      cb.current.onSelectNode?.(n.node)
      cb.current.onSelectEdge?.(null)
    })
    graph.on('node:dblclick', (evt: unknown) => {
      const id = idOf(evt)
      if (id && nodeById.has(id)) cb.current.onEnterEgo?.(id)
    })
    graph.on('edge:click', (evt: unknown) => {
      const e = edgeById.get(idOf(evt) ?? '')
      if (!e) return
      cb.current.onSelectEdge?.(e.edge)
      cb.current.onSelectNode?.(null)
    })
    graph.on('canvas:click', clear)
    graph.on('combo:click', clear)

    graph.on('node:pointerenter', (evt: unknown) => {
      const n = nodeById.get(idOf(evt) ?? '')
      if (!n) return
      hoverNodeRef.current = n.id
      hoverEdgeRef.current = null
      cb.current.onHover?.({ kind: 'node', node: n.node, ...local(evt) })
      schedule()
    })
    graph.on('node:pointermove', (evt: unknown) => {
      const n = nodeById.get(idOf(evt) ?? '')
      if (n && hoverNodeRef.current === n.id) cb.current.onHover?.({ kind: 'node', node: n.node, ...local(evt) })
    })
    graph.on('node:pointerleave', () => {
      hoverNodeRef.current = null
      cb.current.onHover?.(null)
      schedule()
    })
    graph.on('edge:pointerenter', (evt: unknown) => {
      const e = edgeById.get(idOf(evt) ?? '')
      if (!e || hoverNodeRef.current) return
      hoverEdgeRef.current = e.id
      cb.current.onHover?.({ kind: 'edge', edge: e.edge, ...local(evt) })
      schedule()
    })
    graph.on('edge:pointermove', (evt: unknown) => {
      const e = edgeById.get(idOf(evt) ?? '')
      if (e && hoverEdgeRef.current === e.id) cb.current.onHover?.({ kind: 'edge', edge: e.edge, ...local(evt) })
    })
    graph.on('edge:pointerleave', () => {
      hoverEdgeRef.current = null
      cb.current.onHover?.(null)
      schedule()
    })
    // 缩放分级：名字 / 连线文字随缩放显隐
    graph.on('aftertransform', () => schedule())

    graphRef.current = graph
    readyRef.current = (async () => {
      await graph.render()
      if (graphRef.current !== graph) return
      await fitRef.current(graph)
      if (graphRef.current !== graph) return
      restyleRef.current(true)
    })().catch(() => {
      /* 图可能已被重建 / 销毁 */
    })

    return () => {
      container.removeEventListener('pointerdown', onDown, true)
      cb.current.onHover?.(null)
      graph.destroy()
      if (graphRef.current === graph) graphRef.current = null
    }
  }, [scene, containerRef, schedule])

  // ── 选中：只重算样式 ──
  useEffect(() => {
    selectedNodeRef.current = selectedPersonId
    selectedEdgeRef.current = selectedEdgeId
    schedule()
  }, [selectedPersonId, selectedEdgeId, schedule])

  // ── 主题：data-theme 变化或系统深浅色变化后重读 CSS 变量，整体重算样式 ──
  useEffect(() => {
    const refresh = () => {
      paletteRef.current = readPalette()
      schedule(true)
    }
    const mo = new MutationObserver(refresh)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', refresh)
    // 衬线字体晚到时重画一次，免得名字停在回退字体上
    void document.fonts?.ready.then(() => schedule(true))
    return () => {
      mo.disconnect()
      mq.removeEventListener('change', refresh)
    }
  }, [schedule])

  // ── 搜索聚焦：一段式镜头推进 ──
  useEffect(() => {
    if (!focusRequest) return
    const { personId } = focusRequest
    let disposed = false
    let cancel: (() => void) | null = null
    void readyRef.current.then(() => {
      const g = graphRef.current
      const container = containerRef.current
      if (disposed || !g || !container) return
      try {
        if (!g.getNodeData().some((n) => n.id === personId)) return
        const [tx, ty] = g.getElementPosition(personId)
        cancel = dollyTo(g, container, [tx, ty], Math.max(g.getZoom(), FOCUS.zoom), FOCUS.duration)
        dollyCancelRef.current = cancel
      } catch {
        /* 图可能已被重建 / 销毁 */
      }
    })
    return () => {
      disposed = true
      cancel?.()
      dollyCancelRef.current = null
    }
  }, [focusRequest, containerRef])

  // ── 工具条放大 / 缩小：围绕视口中心平滑推拉 ──
  useEffect(() => {
    if (!zoomRequest) return
    void readyRef.current.then(() => {
      const g = graphRef.current
      const container = containerRef.current
      if (!g || !container || g.destroyed) return
      dollyCancelRef.current?.()
      const [lo, hi] = [0.08, 4]
      const z = g.getZoom() * (zoomRequest.kind === 'in' ? ZOOM_STEP : 1 / ZOOM_STEP)
      const [cx, cy] = g.getViewportCenter()
      dollyCancelRef.current = dollyTo(g, container, [cx, cy], Math.min(hi, Math.max(lo, z)), 220)
    })
  }, [zoomRequest, containerRef])

  // ── 容器尺寸跟随（ResizeObserver；折叠侧栏不会触发 window resize） ──
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let raf = 0
    let lastW = container.clientWidth
    let lastH = container.clientHeight
    const apply = () => {
      raf = 0
      const g = graphRef.current
      if (!g) return
      const w = container.clientWidth
      const h = container.clientHeight
      if ((w === lastW && h === lastH) || w < 1 || h < 1) return
      lastW = w
      lastH = h
      dollyCancelRef.current?.()
      dollyCancelRef.current = null
      try {
        g.setSize(w, h)
      } catch {
        /* 图可能正在销毁 */
      }
    }
    const scheduleResize = () => {
      if (!raf) raf = requestAnimationFrame(apply)
    }
    const ro = new ResizeObserver(scheduleResize)
    ro.observe(container)
    window.addEventListener('resize', scheduleResize)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', scheduleResize)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [containerRef])

  // ── 离散的「适应窗口」请求 ──
  useEffect(() => {
    if (!refitToken) return
    let disposed = false
    // 等一帧：CSS 布局已生效、上面的 RO 也已在同批里 setSize
    const raf = requestAnimationFrame(() => {
      if (disposed) return
      void readyRef.current.then(() => {
        const g = graphRef.current
        if (g) void fitRef.current(g).catch(() => {})
      })
    })
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
    }
  }, [refitToken])

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    },
    [],
  )
}
