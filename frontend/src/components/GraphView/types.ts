/** 图谱组件的对外 props 与内部共享类型（布局模式、镜头请求、视图切片、场景模型）。 */
import type { GraphData, GraphEdge, GraphNode } from '../../api'

/**
 * 两种布局模式（PRD §5.7.5 B）：
 * - faction（默认，大图主路径）：每个势力一块半透明圆角区块，块内核心人物居中、其余按亲疏分环
 * - affinity（辅模式）：以主角 / 中心人物为圆心，按与他关系的硬 / 中 / 软 / 间接分档成扇区
 */
export type LayoutMode = 'faction' | 'affinity'

/** 搜索聚焦请求：nonce 变化才重新播动画（同一人可反复聚焦） */
export type FocusRequest = { personId: string; nonce: number }

/** 工具条的放大 / 缩小请求：nonce 变化才执行一次 */
export type ZoomRequest = { kind: 'in' | 'out'; nonce: number }

export type Hardness = 'hard' | 'medium' | 'soft'

export type GraphViewProps = {
  data: GraphData
  layoutMode?: LayoutMode
  /** 只看这几个势力块；空数组 = 全部。仅势力模式生效 */
  selectedFactions?: string[]
  /** 搜索命中后聚焦到某人（平移 + 推近） */
  focusRequest?: FocusRequest | null
  /** 工具条放大 / 缩小 */
  zoomRequest?: ZoomRequest | null
  /** 当前选中人物（单击或搜索命中）；非空时描边高亮，并显示与他相关的连线文字 */
  selectedPersonId?: string | null
  /** 当前选中的连线；非空时加粗显示 */
  selectedEdge?: GraphEdge | null
  /** 非空时：中心视图，仅显示该人 + 一度邻居 */
  egoPersonId?: string | null
  /**
   * 离散的布局变化（折叠侧栏、点「适应窗口」）后，父组件递增这个值来请求重新框图。
   * 不在 ResizeObserver 里自动 refit：拖窗口时连续 refit 会和用户手动的缩放 / 平移打架。
   */
  refitToken?: number
  /** 当前范围说明（全书 / 第 N 章 / 前 N 章），显示在中心视图路径条里 */
  scopeLabel?: string
  onSelectEdge?: (edge: GraphEdge | null) => void
  onSelectNode?: (node: GraphNode | null) => void
  /** 双击人物：进入以他为中心的视图 */
  onEnterEgo?: (personId: string) => void
  onExitEgo?: () => void
}

export type GraphSlice = {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** 画布上一个人物（位置已定，样式随交互 / 主题 / 缩放另算） */
export type SceneNode = {
  id: string
  node: GraphNode
  x: number
  y: number
  /** 势力色槽（0 = 未归属），见 factions.ts */
  slot: number
  /** 半径 */
  r: number
  /** 中心视图的中心人物 */
  center: boolean
  /** 所在势力区块（G6 combo id）；无区块时缺省 */
  combo?: string
}

export type SceneEdge = {
  id: string
  edge: GraphEdge
  source: string
  target: string
  /** 最强标签的硬度，决定线型 */
  hardness: Hardness
  /** 单章模式下有本章依据（加粗突出）；false 且单章 = 背景淡化 */
  inFocus: boolean
  labelText: string
  /** 连线文字在线上的位置（0~1） */
  labelRatio: number
  /** 默认状态下这条线的文字有空间放（不与人物、名字、其它连线文字重叠） */
  labelFits: boolean
}

export type SceneCombo = {
  id: string
  name: string
  slot: number
}

/** 一次建图所需的全部静态信息 */
export type Scene = {
  nodes: SceneNode[]
  edges: SceneEdge[]
  combos: SceneCombo[]
  /** 单章模式：本章依据突出、其余淡化 */
  focusSingle: boolean
  /** 人多：默认不显示连线文字，放大或悬停 / 选中时再显示 */
  dense: boolean
  /** 邻接表（悬停高亮一度邻居用） */
  neighbors: Map<string, Set<string>>
}
