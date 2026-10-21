/**
 * 图区常驻小蜘蛛（看板）：挂在右上角，眼睛跟着悬停的人物看，久不操作就打盹；
 * 每次换图后小跳一下；加载慢时沿丝降下来等着；点它冒一句小提示。纯陪伴，不影响图的交互。
 */
import { useEffect, useRef, useState } from 'react'
import { Spider } from '../Spider'
import type { HoverInfo } from './useGraphInstance'

/** 多久没动静就打盹 */
const DOZE_MS = 60_000
const SAY_MS = 3200
const LINES = [
  '双击人物，只看他的关系圈',
  '单章或区间时，按 ← → 翻章',
  '按 / 搜索人物',
  '这张网是我织的',
  '别戳，在数人头',
  '今天也在认真结网',
]
/** 与 CSS 一致：身体宽、离右边距离、降下时的高度占比 */
const SIZE = 72
const RIGHT = 76
const DOWN = 0.38

interface Props {
  hover: HoverInfo | null
  /** 加载已经慢到需要提示 */
  down: boolean
  /** 每换一次图加一，用来触发小跳 */
  hop: number
  width: number
  height: number
}

export function GraphSpider({ hover, down, hop, width, height }: Props) {
  const [asleep, setAsleep] = useState(false)
  const [say, setSay] = useState<string | null>(null)
  const said = useRef(0)

  useEffect(() => {
    let t = window.setTimeout(() => setAsleep(true), DOZE_MS)
    const wake = () => {
      window.clearTimeout(t)
      setAsleep(false)
      t = window.setTimeout(() => setAsleep(true), DOZE_MS)
    }
    window.addEventListener('pointermove', wake, { passive: true })
    window.addEventListener('keydown', wake)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('keydown', wake)
    }
  }, [])

  useEffect(() => {
    if (!say) return
    const t = window.setTimeout(() => setSay(null), SAY_MS)
    return () => window.clearTimeout(t)
  }, [say])

  // 瞳孔朝悬停的人看：从眼睛位置指向鼠标
  let look: { x: number; y: number } | null = null
  if (hover) {
    const dx = hover.x - (width - RIGHT - SIZE / 2)
    const dy = hover.y - ((down ? height * DOWN : 0) + SIZE * 0.45)
    const len = Math.hypot(dx, dy)
    if (len > 1) look = { x: dx / len, y: dy / len }
  }

  const text = down ? '正在铺开人物图…' : say

  return (
    <div className={`gspider${down ? ' down' : ''}`}>
      <span className="gspider-silk" />
      <div className="gspider-drop">
        <button
          type="button"
          className="gspider-body"
          aria-label="小蜘蛛：点一下看小提示"
          onClick={() => setSay(LINES[said.current++ % LINES.length])}
        >
          <span key={hop} className="gspider-hop">
            <Spider look={look} asleep={asleep && !down} />
          </span>
          {asleep && !down && <span className="gspider-z" aria-hidden="true">z</span>}
          {text && (
            <span key={text} className="gspider-say" role="status">
              {text}
            </span>
          )}
        </button>
      </div>
    </div>
  )
}
