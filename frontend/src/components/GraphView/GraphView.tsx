/**
 * 人物关系图（图谱区主体）：把后端图数据裁成当前视图（中心视图 / 势力筛选），编排成场景交给 G6 渲染，
 * 并叠加图例、中心视图路径条、悬停浮卡。选人、悬停、切主题都不重建图；只有数据 / 视图范围 / 中心人物 / 布局变了才重建。
 * 通过 ref 对外提供 PNG 导出（PRD §5.7.5）：按当前场景与人物的当前位置重画整张图。
 * 换图转场：重建前截下旧画面盖在上面，新图画好后按切换方向（翻章左右滑、进出范围缩放、其余淡入淡出）播放；
 * 右上角挂一只常驻小蜘蛛，加载慢时降下来提示。
 */
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { GraphData } from '../../api'
import { FeedbackButton } from '../../feedback/FeedbackButton'
import { UNASSIGNED_FACTION_ID } from '../../factions'
import type { GraphViewHandle, GraphViewProps } from './types'
import { downloadBlob, pngFilename, renderGraphPng } from './exportPng'
import { readPalette } from './style'
import { buildScene, egoSubgraph, factionsInView, pickCenter } from './layout'
import { EgoCrumb, GraphLegend, HoverCard } from './legend'
import { GraphSpider } from './GraphSpider'
import { useGraphInstance, type HoverInfo } from './useGraphInstance'

/** 加载超过这么久才降蜘蛛、压暗旧图，快的切换不打扰 */
const SLOW_MS = 300
/** 新图迟迟画不好时，最多盖着旧画面这么久 */
const SHOT_MAX_MS = 3000

type Transition = 'next' | 'prev' | 'in' | 'out' | 'fade'
type ViewKey = { scene: unknown; focus: GraphData['chapter_focus'] | null; ego: string | null }

/** 按前后视图判断转场方向：同模式整体前移 / 后移是翻章，进出章节范围或中心视图是缩放，其余淡入淡出 */
function transitionOf(a: ViewKey, b: ViewKey): Transition {
  if (a.ego !== b.ego) return !a.ego ? 'in' : !b.ego ? 'out' : 'fade'
  const fa = a.focus
  const fb = b.focus
  if (!fa !== !fb) return fb ? 'in' : 'out'
  if (fa && fb && fa.mode === fb.mode) {
    const d = Math.sign(fb.from - fa.from)
    if (d && d === Math.sign(fb.to - fa.to)) return d > 0 ? 'next' : 'prev'
  }
  return 'fade'
}

/** 把 G6 的几层画布合成一张静态截图 */
function snapshot(box: HTMLElement): HTMLCanvasElement | null {
  const layers = [...box.querySelectorAll('canvas')]
  if (!layers.length) return null
  const shot = document.createElement('canvas')
  shot.width = layers[0].width
  shot.height = layers[0].height
  const ctx = shot.getContext('2d')
  if (!ctx) return null
  for (const c of layers) ctx.drawImage(c, 0, 0, shot.width, shot.height)
  shot.className = 'graph-shot'
  return shot
}

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
  loading = false,
  onSelectEdge,
  onSelectNode,
  onEnterEgo,
  onExitEgo,
  ref,
}: GraphViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [groupPick, setGroupPick] = useState<{ id: string; x: number; y: number } | null>(null)

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

  const factionFallback =
    !isEgoMode && layoutMode === 'faction' && !useFactionLayout
      ? `没有可分的势力（${data.partition_degraded_reason ?? '本书没有归纳出团体'}），已改用亲疏扇区`
      : null

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
      // 场景端点可能是势力分身 ID，按原始关系的人物匹配
      (e) => e.edge.person_a === selectedEdge.person_a && e.edge.person_b === selectedEdge.person_b,
    )
    return hit?.id ?? null
  }, [selectedEdge, scene])

  // ── 换图转场：提交新场景时（旧图还没销毁）截下旧画面，新图画好后两者一起按方向动起来 ──
  const shotRef = useRef<HTMLCanvasElement | null>(null)
  const viewRef = useRef<ViewKey | null>(null)
  const [hop, setHop] = useState(0)

  const reveal = useCallback(() => {
    const shot = shotRef.current
    const box = containerRef.current
    if (!shot || !box) return
    shotRef.current = null
    const kind = shot.dataset.kind ?? 'fade'
    box.classList.remove('graph-pending')
    delete box.dataset.enter
    void box.offsetWidth // 连续切换时让入场动画从头播
    box.dataset.enter = kind
    shot.dataset.leave = kind
    shot.addEventListener('animationend', () => shot.remove(), { once: true })
    setHop((h) => h + 1)
  }, [])

  useLayoutEffect(() => {
    const prev = viewRef.current
    if (prev?.scene === scene) return
    const next = { scene, focus: data.chapter_focus ?? null, ego: isEgoMode ? egoPersonId : null }
    viewRef.current = next
    const box = containerRef.current
    const wrap = wrapRef.current
    if (!prev || !box || !wrap) return
    if (!scene) {
      shotRef.current?.remove()
      shotRef.current = null
      box.classList.remove('graph-pending')
      return
    }
    // 上一张新图还没画好又换了：沿用最早的旧画面，只更新方向
    if (!shotRef.current) {
      const shot = snapshot(box)
      if (!shot) return
      box.after(shot)
      box.classList.add('graph-pending')
      shotRef.current = shot
    }
    shotRef.current.dataset.kind = transitionOf(prev, next)
    const t = window.setTimeout(reveal, SHOT_MAX_MS)
    return () => window.clearTimeout(t)
    // 聚焦与中心人物只会随场景一起变，每次换场景只转场一次
  }, [scene, data.chapter_focus, isEgoMode, egoPersonId, reveal])

  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!loading) return
    const t = window.setTimeout(() => setSlow(true), SLOW_MS)
    return () => {
      window.clearTimeout(t)
      setSlow(false)
    }
  }, [loading])

  const { getPositions } = useGraphInstance({
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
    onSelectGroup: setGroupPick,
    onHover: setHover,
    onBuilt: reveal,
  })

  const nameById = useMemo(() => new Map(data.nodes.map((n) => [n.person_id, n.name])), [data.nodes])
  const nameOf = useCallback((id: string) => nameById.get(id) ?? '?', [nameById])

  useImperativeHandle(
    ref,
    (): GraphViewHandle => ({
      async exportPng({ bookTitle, notes = [] }) {
        if (!scene) throw new Error('当前视图没有人物，无法导出图片')
        const view: string[] = []
        if (isEgoMode && egoPersonId) view.push(`以「${nameOf(egoPersonId)}」为中心`)
        else view.push(useFactionLayout ? '势力分区' : '亲疏扇区')
        if (!isEgoMode && layoutMode === 'faction' && selectedFactions.length) {
          const names = data.factions.filter((f) => selectedFactions.includes(f.faction_id)).map((f) => f.name)
          view.push(`只看：${names.slice(0, 4).join('、')}${names.length > 4 ? ` 等 ${names.length} 个势力` : ''}`)
        }
        const positions = await getPositions()
        const res = await renderGraphPng(scene, positions, readPalette(), {
          bookTitle,
          scope: scopeLabel,
          view: [...view, ...notes],
          factions: viewFactions,
          affinity: !useFactionLayout,
        })
        const suffix = isEgoMode && egoPersonId ? `${scopeLabel}-${nameOf(egoPersonId)}` : scopeLabel
        const filename = pngFilename(bookTitle, suffix)
        downloadBlob(res.blob, filename)
        return { filename, width: res.width, height: res.height, scale: res.scale }
      },
    }),
    [scene, isEgoMode, egoPersonId, nameOf, useFactionLayout, layoutMode, selectedFactions, data.factions, getPositions, scopeLabel, viewFactions],
  )

  if (!data.nodes.length) {
    return <div className="graph-empty">暂无人物。可能尚未分析，或筛选过严（试试降低路人过滤阈值）。</div>
  }

  const wrap = wrapRef.current
  const pickedGroup = useFactionLayout && groupPick && scene?.combos.some((c) => c.id === groupPick.id)
    ? viewFactions.find((f) => f.faction_id === groupPick.id && f.faction_id !== UNASSIGNED_FACTION_ID)
    : undefined

  return (
    <div className="graph-wrap" ref={wrapRef}>
      <div className="graph-canvas" ref={containerRef} />
      <div className={`graph-veil${slow ? ' on' : ''}`} />
      <GraphSpider hover={hover} down={slow} hop={hop} width={wrap?.clientWidth ?? 800} height={wrap?.clientHeight ?? 600} />
      {pickedGroup && groupPick && <div className="float feedback-group" style={{ left: Math.max(8, Math.min(groupPick.x, (wrap?.clientWidth ?? 800) - 240)), top: Math.max(8, Math.min(groupPick.y, (wrap?.clientHeight ?? 600) - 100)) }}>
        <strong>{pickedGroup.name}</strong>
        <FeedbackButton target={{ targetKind: 'GROUP', targetRef: pickedGroup.faction_id, targetLabel: pickedGroup.name }} />
        <button type="button" className="btn ghost" aria-label="关闭势力反馈入口" onClick={() => setGroupPick(null)}>✕</button>
      </div>}
      <GraphLegend
        factions={viewFactions}
        showFactions
        focusSingle={focusSingle}
        affinity={!useFactionLayout}
        factionFallback={factionFallback}
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
