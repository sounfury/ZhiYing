/**
 * 图上的悬浮说明件：左下可折叠图例（线型 + 势力色点，势力多时列表滚动）、
 * 中心视图顶部路径条（「范围 › 某人 的关系」+ 退出）、悬停浮卡（人物小卡 / 连线两端与关系）。
 * Esc 退出中心视图由 App 全局处理，这里不重复绑定。
 */
import type { GraphFaction, GraphNode } from '../../api'
import { factionColor } from '../../factions'
import { edgeHardness, tagHardness } from './layout'
import type { HoverInfo } from './useGraphInstance'

const LINES = [
  { key: 'hard', label: '硬', width: 2.2, dash: undefined, cap: undefined },
  { key: 'medium', label: '中', width: 1.8, dash: '6 4', cap: undefined },
  { key: 'soft', label: '软', width: 1.6, dash: '1.5 4', cap: 'round' as const },
]

export function GraphLegend({
  factions,
  showFactions,
  focusSingle,
  affinity,
  factionFallback,
}: {
  factions: GraphFaction[]
  showFactions: boolean
  focusSingle: boolean
  affinity: boolean
  /** 选了势力分区却没有势力可分时的说明（此时已改用亲疏扇区） */
  factionFallback?: string | null
}) {
  return (
    <details className="float fx-legend" open>
      <summary>图例</summary>
      <div className="lg">
        {LINES.map((l) => (
          <div key={l.key}>
            <svg viewBox="0 0 30 8" aria-hidden>
              <line
                x1="1"
                y1="4"
                x2="29"
                y2="4"
                stroke={`var(--${l.key})`}
                strokeWidth={l.width}
                strokeDasharray={l.dash}
                strokeLinecap={l.cap}
              />
            </svg>
            {l.label}
          </div>
        ))}
        {focusSingle && (
          <div>
            <svg viewBox="0 0 30 8" aria-hidden>
              <line x1="1" y1="4" x2="29" y2="4" stroke="var(--hard)" strokeWidth="3.8" />
            </svg>
            本章
          </div>
        )}
      </div>
      {showFactions && factions.length > 0 && (
        <div className="lg lg-factions">
          {factions.map((f) => (
            <div key={f.faction_id} title={`${f.name} · ${f.member_ids.length} 人`}>
              <span className="dot" style={{ background: factionColor(f) }} />
              <span className="nm">{f.name}</span>
            </div>
          ))}
        </div>
      )}
      {factionFallback && <div className="lg-hint warn">{factionFallback}</div>}
      {affinity && <div className="lg-hint">离中心越近，与中心人物的关系越硬</div>}
    </details>
  )
}

export function EgoCrumb({ scope, name, onExit }: { scope: string; name: string; onExit?: () => void }) {
  return (
    <div className="float fx-crumb" role="navigation" aria-label="中心视图">
      <span>
        {scope} › <b>{name}</b> 的关系
      </span>
      <button type="button" onClick={() => onExit?.()}>
        退出 <kbd>Esc</kbd>
      </button>
    </div>
  )
}

const IMPORTANCE_LABEL: Record<string, string> = { main: '主角', supporting: '配角', minor: '龙套' }
const HARDNESS_LABEL = { hard: '硬', medium: '中', soft: '软' }

/** 悬停浮卡：位置跟随指针，靠右 / 靠下时翻到另一侧，不出画布 */
export function HoverCard({
  info,
  width,
  height,
  nameOf,
  singleChapter,
}: {
  info: HoverInfo
  width: number
  height: number
  nameOf: (id: string) => string
  singleChapter: boolean
}) {
  const W = 240
  const H = 120
  const left = info.x + 16 + W > width ? Math.max(8, info.x - 16 - W) : info.x + 16
  const top = info.y + 16 + H > height ? Math.max(8, info.y - 16 - H) : info.y + 16

  return (
    <div className="float graph-tip" style={{ left, top }} role="tooltip">
      {info.kind === 'node' ? <NodeTip node={info.node} singleChapter={singleChapter} /> : (
        <>
          <b>
            {nameOf(info.edge.person_a)} — {nameOf(info.edge.person_b)}
          </b>
          <span className="meta"> · {HARDNESS_LABEL[edgeHardness(info.edge)]}关系</span>
          <ul>
            {info.edge.tags.slice(0, 4).map((t) => (
              <li key={t.key}>
                <span className={`hsym ${tagHardness(t)}`} />
                {t.label}
                {t.in_focus_chapter && <em>本章</em>}
              </li>
            ))}
            {info.edge.tags.length > 4 && <li className="meta">另有 {info.edge.tags.length - 4} 种</li>}
          </ul>
          <div className="meta">单击看依据原文</div>
        </>
      )}
    </div>
  )
}

function NodeTip({ node, singleChapter }: { node: GraphNode; singleChapter: boolean }) {
  return (
    <>
      <b>{node.name}</b>
      <span className="meta">
        {' '}
        · {IMPORTANCE_LABEL[node.importance] ?? node.importance} · 出场 {node.appearance_count} 章
      </span>
      {singleChapter ? (
        <p className="meta">单章视图不显示全书简介，单击看本章摘要</p>
      ) : (
        <p>{node.bio || '路人，暂无简介'}</p>
      )}
      <div className="meta">单击看详情 · 双击以此人为中心</div>
    </>
  )
}
