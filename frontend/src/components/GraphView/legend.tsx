import type { GraphData } from '../../api'
import type { GraphSlice, LayoutMode, LegendItem } from './types'

type Props = {
  data: GraphData
  view: GraphSlice
  legend: LegendItem[]
  layoutMode: LayoutMode
  useFactionLayout: boolean
  isEgoMode: boolean
  selectedFactions: string[]
  centerName: string
  defaultName: string
  unassignedCount: number | null
  onExitEgo?: () => void
}

export function GraphLegend({
  data,
  view,
  legend,
  layoutMode,
  useFactionLayout,
  isEgoMode,
  selectedFactions,
  centerName,
  defaultName,
  unassignedCount,
  onExitEgo,
}: Props) {
  return (
    <div className="graph-legend" aria-label="布局说明">
      <span className="legend-title">
        {isEgoMode ? `仅看：${centerName}` : `中心：${centerName}`}
      </span>
      <span className="legend-mode">
        {useFactionLayout ? '势力分区' : '亲疏扇区'}
      </span>
      {useFactionLayout && selectedFactions.length > 0 && (
        <span className="legend-mode">
          筛选中 {selectedFactions.length}/{data.factions.length} 块 ·{' '}
          {view.nodes.length} 人
        </span>
      )}
      {isEgoMode && (
        <button
          type="button"
          className="legend-reset"
          onClick={() => onExitEgo?.()}
        >
          回到全图（{defaultName}）
        </button>
      )}
      {legend.map((item) => (
        <span key={item.key} className="legend-item">
          <i style={{ background: item.color }} />
          {item.label}
          <em>{item.count}</em>
        </span>
      ))}
      <span className="legend-hint">
        {layoutMode === 'faction' && !useFactionLayout
          ? '尚无势力册：先点「抽取势力」，或用亲疏扇区模式看图'
          : useFactionLayout
            ? `角度=势力块，半径=块内亲疏（越靠内越亲）· 虚线圈=跨块桥接人物${
                unassignedCount != null ? ` · 未归属 ${unassignedCount} 人` : ''
              }`
            : '单击人物看详情 · 详情里点「只看与此人的关系」· 拖动画布看图'}
      </span>
    </div>
  )
}
