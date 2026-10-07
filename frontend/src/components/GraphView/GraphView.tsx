/**
 * 人物关系图（图谱区主体）：把后端图数据裁成当前视图（中心视图 / 势力筛选），编排成场景交给 G6 渲染，
 * 并叠加图例、中心视图路径条、悬停浮卡。选人、悬停、切主题都不重建图；只有数据 / 视图范围 / 中心人物 / 布局变了才重建。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { UNASSIGNED_FACTION_ID } from '../../factions'
import type { GraphViewProps } from './types'
import { buildScene, egoSubgraph, factionsInView, pickCenter } from './layout'
import { EgoCrumb, GraphLegend, HoverCard } from './legend'
import { useGraphInstance, type HoverInfo } from './useGraphInstance'

export function GraphView({
  data,
  layoutMode = 'faction',
  selectedFactions = [],
  focusRequest = null,
  zoomRequest = null,
  selectedPersonId = null,
  selectedEdge = null,
  egoPersonId = null,
  refitToken = 0,
  scopeLabel = '全书',
  onSelectEdge,
  onSelectNode,
  onEnterEgo,
  onExitEgo,
}: GraphViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<HoverInfo | null>(null)

  const defaultCenterId = useMemo(() => pickCenter(data.nodes, data.edges), [data.nodes, data.edges])
  const isEgoMode = !!egoPersonId && data.nodes.some((n) => n.person_id === egoPersonId)
  const centerId = isEgoMode ? egoPersonId : defaultCenterId
  const focusSingle = data.chapter_focus?.mode === 'single'

  /** 实际绘制的人与边：中心视图取一度邻域；势力分区下按势力筛选裁块（中心人物始终保留） */
  const view = useMemo(() => {
    if (isEgoMode && egoPersonId) return egoSubgraph(data, egoPersonId)
    if (layoutMode !== 'faction' || !selectedFactions.length) return { nodes: data.nodes, edges: data.edges }
    const keep = new Set(selectedFactions)
    const nodes = data.nodes.filter(
      (n) => n.person_id === centerId || (n.primary_faction_id !== null && keep.has(n.primary_faction_id)),
    )
    const ids = new Set(nodes.map((n) => n.person_id))
    return { nodes, edges: data.edges.filter((e) => ids.has(e.person_a) && ids.has(e.person_b)) }
  }, [data, centerId, isEgoMode, egoPersonId, layoutMode, selectedFactions])

  const viewFactions = useMemo(() => factionsInView(data.factions, view.nodes), [data.factions, view.nodes])

  /**
   * 势力分区只在真有块可分时生效：只剩「未归属」等于没分区，退回亲疏扇区。
   * 中心视图本身就是「以某人为圆心」，固定用亲疏扇区。
   */
  const useFactionLayout =
    !isEgoMode && layoutMode === 'faction' && viewFactions.some((f) => f.faction_id !== UNASSIGNED_FACTION_ID)

  const scene = useMemo(
    () =>
      view.nodes.length
        ? buildScene({
            slice: view,
            factions: viewFactions,
            centerId,
            egoId: isEgoMode ? egoPersonId : null,
            useFactionLayout,
            focusSingle,
          })
        : null,
    [view, viewFactions, centerId, isEgoMode, egoPersonId, useFactionLayout, focusSingle],
  )

  const selectedEdgeId = useMemo(() => {
    if (!selectedEdge || !scene) return null
    const hit = scene.edges.find(
      (e) =>
        (e.source === selectedEdge.person_a && e.target === selectedEdge.person_b) ||
        (e.source === selectedEdge.person_b && e.target === selectedEdge.person_a),
    )
    return hit?.id ?? null
  }, [selectedEdge, scene])

  useGraphInstance({
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
    onHover: setHover,
  })

  const nameById = useMemo(() => new Map(data.nodes.map((n) => [n.person_id, n.name])), [data.nodes])
  const nameOf = useCallback((id: string) => nameById.get(id) ?? '?', [nameById])

  if (!data.nodes.length) {
    return <div className="graph-empty">暂无人物。可能尚未分析，或筛选过严（试试降低路人过滤阈值）。</div>
  }

  const wrap = wrapRef.current

  return (
    <div className="graph-wrap" ref={wrapRef}>
      <div className="graph-canvas" ref={containerRef} />
      <GraphLegend
        factions={viewFactions}
        showFactions
        focusSingle={focusSingle}
        affinity={!useFactionLayout}
      />
      {isEgoMode && egoPersonId && (
        <EgoCrumb scope={scopeLabel} name={nameOf(egoPersonId)} onExit={onExitEgo} />
      )}
      {hover && (
        <HoverCard
          info={hover}
          width={wrap?.clientWidth ?? 800}
          height={wrap?.clientHeight ?? 600}
          nameOf={nameOf}
          singleChapter={focusSingle}
        />
      )}
    </div>
  )
}
