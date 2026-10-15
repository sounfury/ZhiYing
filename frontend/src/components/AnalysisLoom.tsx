/**
 * 整书分析等待动画（PRD §5.9 等待展示）：左边小蜘蛛在手里的网上来回织线，右边逐个滚出新登场人物名。
 * 下方细条是逐章经线：排队虚线、在读闪光、读完落定、失败断开，保留真实的章级信息。
 * 纯装饰部分对读屏隐藏，人名与进度另以文字输出。
 */
import type { AnalysisTaskChapter } from '../api'
import type { NewPerson } from '../types'
import spider from '../assets/loom-spider.webp'

/** 经线最多根数，超过时相邻章合并成一根 */
const MAX_COLS = 120
/** 滚动栏里同时显示的人名数 */
const SHOWN = 5
/** 织线叠在蜘蛛图上，坐标与原图（1402 × 1122）一致，落在前爪捧着的小网上 */
const WEFTS = [600, 670, 740, 810].map((y, i) => `M${380 + i * 12},${y} L${720 - i * 18},${y + 14}`)
const WARP = 'M400,560 L470,880 M520,560 L540,900 M640,580 L610,900'

type Thread = 'pending' | 'running' | 'done' | 'reused' | 'failed'

/** 一根经线覆盖的章合并后的状态 */
function column(group: AnalysisTaskChapter[]): Thread {
  if (group.some((c) => c.status === 'failed')) return 'failed'
  const settled = group.filter((c) => c.status === 'done' || c.status === 'partial')
  if (settled.length === group.length) return settled.every((c) => c.reused) ? 'reused' : 'done'
  return group.some((c) => c.status === 'running') || settled.length ? 'running' : 'pending'
}

interface Props {
  chapters: AnalysisTaskChapter[]
  phase: string
  newPersons: NewPerson[]
}

export function AnalysisLoom({ chapters, phase, newPersons }: Props) {
  const n = chapters.length
  const cols = Math.min(n, MAX_COLS)
  const threads = Array.from({ length: cols }, (_, i) => column(chapters.slice(Math.floor((i * n) / cols), Math.floor(((i + 1) * n) / cols))))
  const read = chapters.filter((c) => c.status === 'done' || c.status === 'partial').length
  const shown = newPersons.slice(-SHOWN)

  return (
    <div className={`loom phase-${phase}`}>
      <div className="loom-stage">
        <div className="loom-spider" aria-hidden="true">
          <img src={spider} alt="" />
          <svg viewBox="0 0 1402 1122">
            <path className="loom-warp-lines" d={WARP} />
            {WEFTS.map((d, i) => (
              <path key={i} className="loom-weft" d={d} pathLength={100} style={{ animationDelay: `${i * 0.5}s` }} />
            ))}
          </svg>
        </div>
        <ol className="loom-names" aria-label="新登场人物">
          {shown.length ? (
            shown.map((p) => <li key={p.id}>{p.name}</li>)
          ) : (
            <li className="empty">读完一章，新登场的人物会出现在这里</li>
          )}
        </ol>
      </div>
      <svg className="loom-warp" viewBox={`0 0 ${Math.max(cols, 1)} 10`} preserveAspectRatio="none" aria-hidden="true">
        {threads.map((t, i) =>
          t === 'failed' ? (
            <g key={i} className="loom-thread failed">
              <line x1={i + 0.5} x2={i + 0.5} y1={0} y2={3.5} />
              <line x1={i + 0.5} x2={i + 0.5} y1={6.5} y2={10} />
            </g>
          ) : (
            <line key={i} className={`loom-thread ${t}`} x1={i + 0.5} x2={i + 0.5} y1={0} y2={10} pathLength={100} />
          ),
        )}
      </svg>
      <p className="loom-cap">
        {phase === 'reading' || phase === 'preparing' ? `已读 ${read} / ${n} 章` : '章节已读完，正在汇总'}
        <span>可以关闭页面，分析会在后台继续</span>
      </p>
    </div>
  )
}
