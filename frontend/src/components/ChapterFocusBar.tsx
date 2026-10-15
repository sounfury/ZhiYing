/**
 * 章节聚焦条（图左上悬浮卡，PRD §5.7.1）：全书 / 单章 / 区间三态切换 + 章节选择 + 一行范围说明。
 * 单章：章节少时是带刻度的滑轨，多（> 12）时是单滑块；区间：双滑块两端都可拖，另可直接输入起止章号。
 * 拖动只改本地草稿并在说明行实时显示章名，松手才提交，上千章也不会每格请求一次图。
 * ← → 翻章（区间时整体平移窗口；焦点在输入框 / 滑块里时不抢键）。只持有纯 UI 行为，范围值由上层管理。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChapterBrief } from '../api'
import type { ChapterFocusState } from '../types'
import { chapterShortNames, formatWords } from '../chapterNames'

interface Props {
  chapters: ChapterBrief[]
  focus: ChapterFocusState
  onChange: (v: ChapterFocusState) => void
  disabled?: boolean
  /** 单章模式下本章入图人数（来自当前图） */
  peopleCount?: number
}

const MODES: { mode: ChapterFocusState['mode']; label: string }[] = [
  { mode: 'all', label: '全书' },
  { mode: 'single', label: '单章' },
  { mode: 'range', label: '区间' },
]

/** 超过这么多章就不画刻度，改用滑块 */
const MAX_TICKS = 12

function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null
  if (!t) return false
  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName) || t.isContentEditable
}

/** 章号输入框：显示正文序号（1 起），回车或失焦才提交，Esc 放弃 */
function ChapterInput({ label, value, max, disabled, onCommit }: {
  label: string
  value: number
  max: number
  disabled?: boolean
  onCommit: (v: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  const commit = () => {
    if (text == null) return
    setText(null)
    const v = Number(text)
    if (text.trim() && Number.isInteger(v)) onCommit(v)
  }
  return (
    <input
      type="number"
      inputMode="numeric"
      min={1}
      max={max}
      step={1}
      aria-label={label}
      value={text ?? value}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setText(null)
      }}
    />
  )
}

export function ChapterFocusBar({ chapters, focus, onChange, disabled, peopleCount }: Props) {
  const names = chapterShortNames(chapters)
  const off = focus.mode === 'all'
  const n = chapters.length
  const indexOf = (id: number) => chapters.findIndex((c) => c.chapter_id === id)
  const idx = off ? -1 : indexOf(focus.to)
  const committed: [number, number] = off ? [0, Math.max(n - 1, 0)] : [Math.max(indexOf(focus.from), 0), Math.max(idx, 0)]
  // 拖动中的草稿（正文下标）；ref 同步一份，松手事件里读最新值
  const [draft, setDraftState] = useState<[number, number] | null>(null)
  const draftRef = useRef<[number, number] | null>(null)
  const [error, setError] = useState('')
  const setDraft = (v: [number, number] | null) => {
    draftRef.current = v
    setDraftState(v)
  }
  const [cLo, cHi] = committed
  const [lo, hi] = draft ?? committed

  const submit = (mode: 'single' | 'range', a: number, b: number) => {
    const from = chapters[a]
    const to = chapters[b]
    if (!from || !to || disabled) return
    setError('')
    onChange({ mode, from: from.chapter_id, to: to.chapter_id })
  }
  const goTo = (i: number) => submit('single', i, i)
  const endDrag = () => {
    const d = draftRef.current
    if (!d) return
    setDraft(null)
    if (focus.mode === 'range') submit('range', d[0], d[1])
    else goTo(d[1])
  }
  const commitInput = (which: 'from' | 'to', v: number) => {
    const i = Math.min(Math.max(v, 1), n) - 1
    const [a, b] = which === 'from' ? [i, hi] : [lo, i]
    if (a > b) {
      setError('起始章不能大于结束章')
      return
    }
    submit('range', a, b)
  }

  // ← → 翻章：单章逐章翻，区间整体平移；输入框、下拉、滑块自己处理方向键
  useEffect(() => {
    if (off || disabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isTypingTarget(e.target)) return
      const d = e.key === 'ArrowRight' ? 1 : -1
      const a = cLo + d
      const b = cHi + d
      if (a < 0 || b >= n) return
      e.preventDefault()
      onChange(
        focus.mode === 'range'
          ? { mode: 'range', from: chapters[a].chapter_id, to: chapters[b].chapter_id }
          : { mode: 'single', from: chapters[b].chapter_id, to: chapters[b].chapter_id },
      )
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [off, disabled, chapters, cLo, cHi, n, focus.mode, onChange])

  const switchMode = (mode: ChapterFocusState['mode']) => {
    setError('')
    if (mode === 'all') onChange({ mode, from: 0, to: 0 })
    // 单章切区间时取「前 N 章」，全书切区间时 to = 0 由上层补成整本
    else if (mode === 'range') onChange({ mode, from: chapters[0]?.chapter_id ?? 0, to: off ? 0 : focus.to })
    else onChange({ mode, from: focus.to, to: focus.to })
  }

  const title = (i: number) => chapters[i]?.title || names[i]
  const tip = (i: number) => `${title(i)} · ${formatWords(chapters[i].word_count)}`
  const pct = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100)
  const dragEnd = { onPointerUp: endDrag, onKeyUp: endDrag, onBlur: endDrag }
  const range = focus.mode === 'range'

  return (
    <div className="chapter-focus" role="group" aria-label="章节聚焦">
      <div className="fx-row">
        <div className="seg" role="radiogroup" aria-label="范围">
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              role="radio"
              aria-checked={focus.mode === m.mode}
              className={focus.mode === m.mode ? 'on' : ''}
              disabled={disabled || (m.mode !== 'all' && !n)}
              onClick={() => switchMode(m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="lbl">
          <kbd>←</kbd> <kbd>→</kbd> {range ? '平移' : '翻章'}
        </span>
      </div>

      {!range && n > 0 && n <= MAX_TICKS && (
        <div className={`track${off ? ' disabled' : ''}`}>
          <div className="rail" />
          {chapters.map((c, i) => (
            <button
              key={c.chapter_id}
              type="button"
              className={`tick${i === idx ? ' cur' : ''}`}
              style={{ left: `${pct(i)}%` }}
              title={tip(i)}
              disabled={disabled}
              onClick={() => goTo(i)}
            >
              <i />
              <span>{names[i]}</span>
            </button>
          ))}
        </div>
      )}

      {!range && n > MAX_TICKS && (
        <div className={`chapter-slider${off ? ' disabled' : ''}`}>
          <button type="button" className="step" disabled={disabled || off || idx <= 0} onClick={() => goTo(idx - 1)} aria-label="上一章">
            ‹
          </button>
          <input
            type="range"
            min={0}
            max={n - 1}
            value={draft ? hi : Math.max(idx, 0)}
            disabled={disabled}
            aria-label="选择章节"
            aria-valuetext={title(draft ? hi : Math.max(idx, 0))}
            title={idx >= 0 ? tip(idx) : '拖动选择章节'}
            onChange={(e) => setDraft([Number(e.target.value), Number(e.target.value)])}
            {...dragEnd}
          />
          <button type="button" className="step" disabled={disabled || off || idx >= n - 1} onClick={() => goTo(idx + 1)} aria-label="下一章">
            ›
          </button>
          <span className="pos">{idx >= 0 || draft ? `${hi + 1} / ${n}` : `共 ${n} 章`}</span>
        </div>
      )}

      {range && n > 0 && (
        <>
          <div className="range-slider">
            <div className="rail" />
            <div className="fill" style={{ left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }} />
            <input
              type="range"
              min={0}
              max={n - 1}
              value={lo}
              disabled={disabled}
              aria-label="起始章"
              aria-valuetext={title(lo)}
              // 两端重合在最右时，起始端要在上层才拖得动
              className={lo === hi && hi === n - 1 ? 'top' : ''}
              onChange={(e) => setDraft([Math.min(Number(e.target.value), hi), hi])}
              {...dragEnd}
            />
            <input
              type="range"
              min={0}
              max={n - 1}
              value={hi}
              disabled={disabled}
              aria-label="结束章"
              aria-valuetext={title(hi)}
              onChange={(e) => setDraft([lo, Math.max(Number(e.target.value), lo)])}
              {...dragEnd}
            />
          </div>
          <div className="range-inputs">
            <span>第</span>
            <ChapterInput label="起始章" value={lo + 1} max={n} disabled={disabled} onCommit={(v) => commitInput('from', v)} />
            <span>–</span>
            <ChapterInput label="结束章" value={hi + 1} max={n} disabled={disabled} onCommit={(v) => commitInput('to', v)} />
            <span>章 · 共 {n} 章</span>
            {error && <span className="err" role="alert">{error}</span>}
          </div>
        </>
      )}

      <div className="cap">
        {off || idx < 0 ? (
          <span>显示全书汇总。切到「单章」看某一章里有谁，「区间」只看某几章</span>
        ) : !range ? (
          <>
            <b title={title(hi)}>{names[hi]}</b>
            {title(hi) !== names[hi] && <span className="ttl">{title(hi)}</span>}
            <span>
              · {formatWords(chapters[hi].word_count)}
              {!draft && peopleCount != null && ` · 本章 ${peopleCount} 人`} · 粗线为本章发生的关系
            </span>
          </>
        ) : (
          <>
            <b title={title(lo)}>{names[lo]}</b>
            {title(lo) !== names[lo] && <span className="ttl">{title(lo)}</span>}
            <span>–</span>
            <b title={title(hi)}>{names[hi]}</b>
            {title(hi) !== names[hi] && <span className="ttl">{title(hi)}</span>}
            <span>· {hi - lo + 1} 章，只用这几章的信息出图</span>
          </>
        )}
      </div>
    </div>
  )
}
