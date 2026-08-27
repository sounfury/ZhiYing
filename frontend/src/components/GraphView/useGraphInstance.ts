import { useEffect, useRef, type RefObject } from 'react'
import { Graph } from '@antv/g6'
import type { GraphData, GraphEdge, GraphFaction, GraphNode } from '../../api'
import type { FocusRequest, GraphSlice } from './types'
import { FOCUS, dollyTo } from './camera'
import { placeByAffinity, placeByFaction } from './layout'
import { LABEL_PREFIX, NODE_FOCUS_STATE, buildG6Model } from './style'

type Args = {
  containerRef: RefObject<HTMLDivElement | null>
  data: GraphData
  view: GraphSlice
  centerId: string | null
  isEgoMode: boolean
  useFactionLayout: boolean
  viewFactions: GraphFaction[]
  factionById: Map<string, GraphFaction>
  selectedPersonId: string | null
  focusRequest: FocusRequest | null
  refitToken: number
  onSelectEdge?: (edge: GraphEdge | null) => void
  onSelectNode?: (node: GraphNode | null) => void
}

/**
 * G6 实例生命周期：建图 / 销毁、选中高亮、搜索镜头、容器尺寸、离散 refit。
 * 建图仍是「数据一变就 destroy + new Graph」——行为与拆分前一致。
 */
export function useGraphInstance({
  containerRef,
  data,
  view,
  centerId,
  isEgoMode,
  useFactionLayout,
  viewFactions,
  factionById,
  selectedPersonId,
  focusRequest,
  refitToken,
  onSelectEdge,
  onSelectNode,
}: Args) {
  const graphRef = useRef<Graph | null>(null)
  /**
   * 当前图「画完并框好」的时刻。选中高亮 / 镜头推进都等它落定再动手——
   * 以前是各拍一个 50/60/100ms 的 setTimeout 互相错开，既凭空慢半拍，
   * 又会在重建图时和 fitView 抢镜头。
   */
  const readyRef = useRef<Promise<void>>(Promise.resolve())
  /** 在飞的镜头推进的取消句柄：容器尺寸一变，它捕获的画布中心就过期了 */
  const dollyCancelRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!containerRef.current || !centerId) return

    graphRef.current?.destroy()
    graphRef.current = null

    const nodeById = new Map(view.nodes.map((n) => [n.person_id, n]))
    // 全量 map 用于点选时仍能回传完整节点（侧栏）
    const fullNodeById = new Map(data.nodes.map((n) => [n.person_id, n]))
    const width = containerRef.current.clientWidth || 800
    const height = containerRef.current.clientHeight || 560
    const cx = width / 2
    const cy = height / 2

    const placed = useFactionLayout
      ? placeByFaction(view.nodes, view.edges, viewFactions, centerId, cx, cy)
      : placeByAffinity(view.nodes, view.edges, centerId, cx, cy)

    const g6Data = buildG6Model({
      view,
      placed,
      centerId,
      cx,
      cy,
      useFactionLayout,
      viewFactions,
      factionById,
      isEgoMode,
    })

    const graph = new Graph({
      container: containerRef.current,
      width,
      height,
      data: g6Data,
      layout: undefined,
      behaviors: ['drag-canvas', 'zoom-canvas'],
      animation: false,
      autoFit: 'view',
      padding: 64,
      node: {
        state: {
          focus: NODE_FOCUS_STATE,
        },
      },
    })

    const pickId = (evt: unknown): string | undefined => {
      const e = evt as { target?: { id?: string } }
      return e.target?.id
    }

    graph.on('node:click', (evt) => {
      const id = pickId(evt)
      if (!id || id.startsWith(LABEL_PREFIX)) return
      // 单击只选中详情，不进入 ego（详情页按钮二次确认）
      onSelectNode?.(fullNodeById.get(id) ?? nodeById.get(id) ?? null)
      onSelectEdge?.(null)
    })

    graph.on('edge:click', (evt) => {
      const id = pickId(evt)
      if (!id) return
      const edgeData = g6Data.edges.find((x) => x.id === id)?.data
      onSelectEdge?.(edgeData ?? null)
      onSelectNode?.(null)
    })

    graph.on('canvas:click', () => {
      onSelectEdge?.(null)
      onSelectNode?.(null)
    })

    graphRef.current = graph

    readyRef.current = (async () => {
      await graph.render()
      // 期间图被重建 / 销毁了就别再动镜头
      if (graphRef.current !== graph) return
      await graph.fitView({ when: 'always', direction: 'both' })
    })().catch(() => {
      /* 图可能已被重建/销毁 */
    })

    return () => {
      graph.destroy()
      graphRef.current = null
    }
  }, [
    data,
    view,
    centerId,
    isEgoMode,
    useFactionLayout,
    viewFactions,
    factionById,
    onSelectEdge,
    onSelectNode,
  ])

  /**
   * 选中高亮：单击节点 / 搜索命中都会把 person_id 设进 selectedPersonId，
   * 这里统一套上 'focus' 态（橙圈 + halo），选中谁就高亮谁，换人或取消时
   * 自动移到新目标 / 褪去。
   *
   * 依赖里带上 view：势力筛选等导致整图重建后，新图上的节点态会清空，
   * 让本 effect 随重建再跑一遍把高亮补回来（只剩未归属块时退回亲疏模式
   * 所引发的重建同样会走到这里）。
   */
  const prevSelectedRef = useRef<string | null>(null)
  useEffect(() => {
    const prevId = prevSelectedRef.current
    const newId = selectedPersonId ?? null
    prevSelectedRef.current = newId

    let disposed = false
    void readyRef.current.then(() => {
      const g = graphRef.current
      if (disposed || !g) return
      if (prevId && prevId !== newId) {
        g.setElementState(prevId, []).catch(() => {})
      }
      if (newId) {
        g.setElementState(newId, ['focus']).catch(() => {})
      }
    })

    return () => {
      disposed = true
    }
  }, [selectedPersonId, view])

  /**
   * 搜索聚焦：一段式镜头推进（平移与推近同一条时间轴，见 dollyTo）。
   *
   * 高亮交给上面的 selectedPersonId effect 统一管理（选中即高亮，不再自动褪去），
   * 这里只负责把镜头对准命中的人。独立于建图 effect，所以不会为了播动画重建整张图。
   */
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
        cancel = dollyTo(
          g,
          container,
          [tx, ty],
          Math.max(g.getZoom(), FOCUS.zoom),
          FOCUS.duration,
        )
        // 也交给 resize 一份：容器尺寸变了这段动画的目标就算错了
        dollyCancelRef.current = cancel
      } catch {
        /* 图可能已被重建/销毁，聚焦失败无所谓 */
      }
    })

    return () => {
      disposed = true
      cancel?.()
      dollyCancelRef.current = null
    }
  }, [focusRequest])

  /**
   * 容器尺寸跟随：G6 的画布尺寸是建图时按容器算死的，之后只能靠 setSize 同步。
   *
   * 原来只听 window resize，但折叠详情栏改变的是 .canvas-wrap 的宽度、**不会**
   * 触发 window resize，canvas 就会僵在旧尺寸和容器脱钩。所以改用 ResizeObserver。
   *
   * 刻意放在独立的、空依赖的 effect 里：建图 effect 的依赖有 data/view/… 一长串，
   * 尺寸处理挂在那里会随每次重建反复拆装监听。
   *
   * 不会造成 RO 死循环——setSize 写的是 G6 内部的 <canvas>，而被观察的
   * .graph-canvas 容器尺寸由 CSS grid 决定，没有自反馈。
   */
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
      if (w === lastW && h === lastH) return // RO 会因滚动条增减等空转
      if (w < 1 || h < 1) return // 容器被折叠隐藏的瞬间
      lastW = w
      lastH = h

      // 在飞的镜头推进捕获的是旧的画布中心，尺寸一变就会推到错位置
      dollyCancelRef.current?.()
      dollyCancelRef.current = null

      try {
        g.setSize(w, h)
      } catch {
        /* 图可能正在销毁 */
      }
    }

    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(apply)
    }

    const ro = new ResizeObserver(schedule)
    ro.observe(container)
    // 兜底：DPR 变化、浏览器 chrome 覆盖层这类不改容器盒子的情况
    window.addEventListener('resize', schedule)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  /** 折叠/展开详情栏这类离散布局变化后，重新框一次图（详见 refitToken 的注释） */
  useEffect(() => {
    if (!refitToken) return
    let disposed = false
    // 等一帧：CSS 布局已生效、上面的 RO 也已在同批里把 setSize 做完
    const raf = requestAnimationFrame(() => {
      if (disposed) return
      void readyRef.current.then(() => {
        graphRef.current
          ?.fitView({ when: 'always', direction: 'both' })
          .catch(() => {})
      })
    })
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
    }
  }, [refitToken])
}
