import type { GraphData, GraphEdge, GraphNode } from '../../api'

/**
 * 两种布局模式，同一套极坐标几何（graphLayout.ts）：
 *
 * - faction（默认，百人级大图主路径，PRD §4.5）
 *     θ = 势力块（学校 / 教会 / 家族…），r = 块内亲疏（越靠内越亲）
 *     解决「朋友太多杂糅一环」：朋友按所属团体散到不同楔形，仍按亲疏分环
 * - affinity（辅模式，原扇区太阳系）
 *     θ = 关系档，r = 该档基准半径 + 环内装填
 *
 * 两者的间距都由 fillWedge 的弦长约束保证不重叠——图会大，缩放后可读。
 */
export type LayoutMode = 'faction' | 'affinity'

/** 搜索聚焦请求：nonce 变化才重新播动画（同一人可反复聚焦） */
export type FocusRequest = { personId: string; nonce: number }

export type SectorId = 'kin' | 'social' | 'weak' | 'indirect' | 'isolate'

export type GraphViewProps = {
  data: GraphData
  layoutMode?: LayoutMode
  /** 只看这几个势力块；空数组 = 全部。仅势力模式生效 */
  selectedFactions?: string[]
  /** 搜索命中后聚焦到某人（平移 + 推近） */
  focusRequest?: FocusRequest | null
  /** 当前选中人物的 person_id（单击或搜索命中都会设置）；非空时持续高亮该节点 */
  selectedPersonId?: string | null
  /** 非空时：仅显示该人 + 与其有边的一度邻居（由详情页按钮触发，非单击节点） */
  egoPersonId?: string | null
  /**
   * 离散的布局变化（目前只有折叠详情栏）后，父组件递增这个值来请求重新框图。
   * 之所以不在 ResizeObserver 里自动 refit：拖窗口时连续 refit 会一直跟用户
   * 手动的缩放/平移打架，而单独 setSize 是保留视口变换的，那才是拖动时想要的。
   */
  refitToken?: number
  onSelectEdge?: (edge: GraphEdge | null) => void
  onSelectNode?: (node: GraphNode | null) => void
  onExitEgo?: () => void
}

export type GraphSlice = {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export type LegendItem = {
  key: string
  label: string
  color: string
  count: number
}
