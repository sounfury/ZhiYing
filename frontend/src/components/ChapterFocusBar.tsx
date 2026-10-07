/**
 * 章节聚焦条（图左上悬浮卡，PRD §5.7.1）：全书 / 单章 / 前 N 章三态切换 + 章节选择 + 一行范围说明。
 * 章节少时是带刻度的滑轨（点刻度直达该章，悬停看标题与字数）；章节多（> 12）时改为可拖动滑块 + 当前章标题，
 * 不把几十个刻度挤在一起。← → 翻章（焦点在输入框 / 下拉里时不抢键）。只持有纯 UI 行为，范围值由上层管理。
 */
import { useEffect } from 'react'
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
  { mode: 'upto', label: '前 N 章' },
]

/** 超过这么多章就不画刻度，改用滑块 */
const MAX_TICKS = 12

function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null
  if (!t) return false
  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName) || t.isContentEditable
}

export function ChapterFocusBar({ chapters, focus, onChange, disabled, peopleCount }: Props) {
  const names = chapterShortNames(chapters)
  const off = focus.mode === 'all'
  const idx = off ? -1 : chapters.findIndex((c) => c.chapter_id === focus.chapter)
  const current = idx >= 0 ? chapters[idx] : undefined
  const n = chapters.length

  const goTo = (i: number) => {
    const c = chapters[i]
    if (!c || disabled) return
    onChange({ mode: off ? 'single' : focus.mode, chapter: c.chapter_id })
  }

  // ← → 翻章：只在单章 / 前 N 章时生效；输入框、下拉、滑块自己处理方向键
  useEffect(() => {
    if (off || disabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isTypingTarget(e.target)) return
      const next = chapters[idx + (e.key === 'ArrowRight' ? 1 : -1)]
      if (!next) return
      e.preventDefault()
      onChange({ mode: focus.mode, chapter: next.chapter_id })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [off, disabled, chapters, idx, focus.mode, onChange])

  const tip = (i: number) => `${chapters[i].title || names[i]} · ${formatWords(chapters[i].word_count)}`
  const pct = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100)

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
              onClick={() => onChange({ mode: m.mode, chapter: focus.chapter })}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="lbl">
          <kbd>←</kbd> <kbd>→</kbd> 翻章
        </span>
      </div>

      {n > 0 && n <= MAX_TICKS && (
        <div className={`track${off ? ' disabled' : ''}`}>
          <div className="rail" />
          <div className="fill" style={{ width: focus.mode === 'upto' && idx >= 0 ? `${pct(idx)}%` : 0 }} />
          {chapters.map((c, i) => (
            <button
              key={c.chapter_id}
              type="button"
              className={`tick${i === idx ? ' cur' : ''}${focus.mode === 'upto' && i <= idx ? ' in' : ''}`}
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

      {n > MAX_TICKS && (
        <div className={`chapter-slider${off ? ' disabled' : ''}`}>
          <button type="button" className="step" disabled={disabled || off || idx <= 0} onClick={() => goTo(idx - 1)} aria-label="上一章">
            ‹
          </button>
          <input
            type="range"
            min={0}
            max={n - 1}
            value={Math.max(idx, 0)}
            disabled={disabled}
            aria-label="选择章节"
            title={idx >= 0 ? tip(idx) : '拖动选择章节'}
            onChange={(e) => goTo(Number(e.target.value))}
          />
          <button type="button" className="step" disabled={disabled || off || idx >= n - 1} onClick={() => goTo(idx + 1)} aria-label="下一章">
            ›
          </button>
          <span className="pos">{idx >= 0 ? `${idx + 1} / ${n}` : `共 ${n} 章`}</span>
        </div>
      )}

      <div className="cap">
        {off || !current ? (
          <span>显示全书汇总。切到「单章」看某一章里有谁、发生了什么</span>
        ) : focus.mode === 'single' ? (
          <>
            <b title={current.title}>{names[idx]}</b>
            {current.title && current.title !== names[idx] && <span className="ttl">{current.title}</span>}
            <span>
              · {formatWords(current.word_count)}
              {peopleCount != null && ` · 本章 ${peopleCount} 人`} · 粗线为本章发生的关系
            </span>
          </>
        ) : (
          <>
            <b>
              {names[0]} – {names[idx]}
            </b>
            <span>· 只用这几章的信息出图</span>
          </>
        )}
      </div>
    </div>
  )
}
