import { useMemo, useRef } from 'react'
import { indexFactions, UNASSIGNED_FACTION_ID } from '../../factions'
import type { GraphViewProps } from './types'
import {
  computeLegend,
  egoSubgraph,
  factionsInView,
  pickCenter,
} from './layout'
import { GraphLegend } from './legend'
import { useGraphInstance } from './useGraphInstance'

export function GraphView({
  data,
  layoutMode = 'faction',
  selectedFactions = [],
  focusRequest = null,
  selectedPersonId = null,
  egoPersonId = null,
  refitToken = 0,
  onSelectEdge,
  onSelectNode,
  onExitEgo,
}: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // 默认主角全图中心
  const defaultCenterId = useMemo(
    () => pickCenter(data.nodes, data.edges),
    [data.nodes, data.edges],
  )

  const isEgoMode = !!(
    egoPersonId && data.nodes.some((n) => n.person_id === egoPersonId)
  )

  const centerId = isEgoMode ? egoPersonId! : defaultCenterId

  /** 实际绘制用的节点/边：ego 模式裁一度邻域；否则按势力筛选裁块 */
  const view = useMemo(() => {
    if (!centerId) return { nodes: data.nodes, edges: data.edges }
    if (isEgoMode) return egoSubgraph(data, centerId)
    if (layoutMode !== 'faction' || !selectedFactions.length) {
      return { nodes: data.nodes, edges: data.edges }
    }
    // 块级下钻：只留选中块的人，主角始终保留当中心
    const keep = new Set(selectedFactions)
    const nodes = data.nodes.filter(
      (n) =>
        n.person_id === centerId ||
        (n.primary_faction_id !== null && keep.has(n.primary_faction_id)),
    )
    const ids = new Set(nodes.map((n) => n.person_id))
    const edges = data.edges.filter(
      (e) => ids.has(e.person_a) && ids.has(e.person_b),
    )
    return { nodes, edges }
  }, [data, centerId, isEgoMode, layoutMode, selectedFactions])

  /** 势力块（按当前视图裁成员）；无势力册时退回亲疏模式 */
  const viewFactions = useMemo(
    () => factionsInView(data.factions, view.nodes),
    [data.factions, view.nodes],
  )

  /**
   * 势力分区只在真有块可分时生效：只剩一个「未归属」块等于没分区，
   * 这时退回亲疏扇区，比画一个巨大的单块可读。
   */
  const useFactionLayout =
    layoutMode === 'faction' &&
    viewFactions.some((f) => f.faction_id !== UNASSIGNED_FACTION_ID)

  const factionById = useMemo(() => indexFactions(viewFactions), [viewFactions])

  const legend = useMemo(
    () =>
      computeLegend({
        useFactionLayout,
        viewFactions,
        view,
        centerId,
      }),
    [useFactionLayout, viewFactions, view, centerId],
  )

  useGraphInstance({
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
  })

  if (!data.nodes.length) {
    return (
      <div className="graph-empty">
        暂无节点。可能尚未分析，或过滤过严（试试降低 min_appearance）。
      </div>
    )
  }

  const centerName =
    data.nodes.find((n) => n.person_id === centerId)?.name ?? '主角'
  const defaultName =
    data.nodes.find((n) => n.person_id === defaultCenterId)?.name ?? '主角'
  const unassigned = viewFactions.find(
    (f) => f.faction_id === UNASSIGNED_FACTION_ID,
  )

  return (
    <div className="graph-wrap">
      <GraphLegend
        data={data}
        view={view}
        legend={legend}
        layoutMode={layoutMode}
        useFactionLayout={useFactionLayout}
        isEgoMode={isEgoMode}
        selectedFactions={selectedFactions}
        centerName={centerName}
        defaultName={defaultName}
        unassignedCount={unassigned ? unassigned.member_ids.length : null}
        onExitEgo={onExitEgo}
      />
      <div className="graph-canvas" ref={containerRef} />
    </div>
  )
}
