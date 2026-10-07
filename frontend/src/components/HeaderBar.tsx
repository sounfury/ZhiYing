/**
 * 顶栏：品牌、书名按钮（点开书架）、人物搜索、累计 token、分析拆分按钮（开始 / 重新分析 / 停止，
 * ▾ 菜单含截止章、只补读失败章、全部重读、导出 JSON）与主题切换。只发出意图，状态由上层持有。
 */
import { useEffect, useRef, useState } from 'react'
import type { BookMeta, ChapterBrief, GraphData } from '../api'
import { formatTokens, formatWords, shortTitle, statusIsWarn, statusLabel } from '../labels'
import { THEME_LABEL, useTheme } from '../theme'
import { PersonSearch, type PersonHit } from './PersonSearch'

interface HeaderBarProps {
  selectedBook?: BookMeta
  contentChapters: ChapterBrief[]
  isRunning: boolean
  graph: GraphData | null
  exporting: boolean
  toChapter: number | ''
  onToChapterChange: (v: number | '') => void
  onOpenShelf: () => void
  onPickPerson: (hit: PersonHit) => void
  onAnalyze: (opts?: { force?: boolean }) => void
  onStop: () => void
  onExport: () => void
}

export function HeaderBar({
  selectedBook,
  contentChapters,
  isRunning,
  graph,
  exporting,
  toChapter,
  onToChapterChange,
  onOpenShelf,
  onPickPerson,
  onAnalyze,
  onStop,
  onExport,
}: HeaderBarProps) {
  const usage = selectedBook?.token_usage
  const words = contentChapters.reduce((n, c) => n + (c.word_count || 0), 0)
  const meta = selectedBook
    ? [
        selectedBook.author || '未知作者',
        contentChapters.length ? `${contentChapters.length} 章正文` : '',
        words ? formatWords(words) : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <header className="top">
      <div className="brand">
        <b>织影</b>
        <span>ZHIYING</span>
      </div>

      <button
        type="button"
        className="book"
        onClick={onOpenShelf}
        title={selectedBook ? `${selectedBook.title}\n点击打开书架` : '打开书架'}
      >
        {selectedBook ? (
          <>
            <span className="t">{shortTitle(selectedBook.title)}</span>
            {meta && <span className="m">{meta}</span>}
            <span className={`pill${!isRunning && statusIsWarn(selectedBook.status) ? ' warn' : ''}`}>
              {isRunning ? '分析中' : statusLabel(selectedBook.status)}
            </span>
          </>
        ) : (
          <span className="t">选择或上传一本书</span>
        )}
        <span className="chev" aria-hidden>
          ▾
        </span>
      </button>

      <span className="grow" />

      {selectedBook && <PersonSearch graph={isRunning ? null : graph} onPick={onPickPerson} />}

      {usage?.total_tokens ? (
        <span
          className="pill warn token-pill"
          title={`累计输入 ${formatTokens(usage.input_tokens)} · 输出 ${formatTokens(usage.output_tokens)} · ${usage.llm_requests} 次请求`}
        >
          {formatTokens(usage.total_tokens)} token
        </span>
      ) : null}

      {selectedBook && (
        <AnalyzeButton
          book={selectedBook}
          contentChapters={contentChapters}
          isRunning={isRunning}
          canExport={Boolean(graph)}
          exporting={exporting}
          toChapter={toChapter}
          onToChapterChange={onToChapterChange}
          onAnalyze={onAnalyze}
          onStop={onStop}
          onExport={onExport}
        />
      )}

      <ThemeToggle />
    </header>
  )
}

interface AnalyzeButtonProps {
  book: BookMeta
  contentChapters: ChapterBrief[]
  isRunning: boolean
  canExport: boolean
  exporting: boolean
  toChapter: number | ''
  onToChapterChange: (v: number | '') => void
  onAnalyze: (opts?: { force?: boolean }) => void
  onStop: () => void
  onExport: () => void
}

/** 分析拆分按钮：主按钮直接启动（复用有效章节结果），▾ 展开更多分析选项与导出。 */
function AnalyzeButton({
  book,
  contentChapters,
  isRunning,
  canExport,
  exporting,
  toChapter,
  onToChapterChange,
  onAnalyze,
  onStop,
  onExport,
}: AnalyzeButtonProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (isRunning) {
    return (
      <button type="button" className="btn danger" onClick={() => void onStop()}>
        停止
      </button>
    )
  }

  const neverAnalyzed = book.status === 'uploaded'
  const hasFailed =
    (book.analysis_progress?.chapters_failed?.length ?? 0) > 0 ||
    ['failed', 'partial', 'cancelled'].includes(book.status)

  const run = (force: boolean) => {
    setOpen(false)
    if (
      force &&
      !window.confirm('全部重读会忽略已有章节结果、重新调用模型，消耗与首次分析相当的 token。确定继续？')
    ) {
      return
    }
    void onAnalyze({ force })
  }

  return (
    <div className="split" ref={wrapRef}>
      <button type="button" className="btn primary" onClick={() => run(false)}>
        {neverAnalyzed ? '开始分析' : '重新分析'}
      </button>
      <button
        type="button"
        className="btn primary"
        aria-label="分析选项"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ▾
      </button>
      {open && (
        <div className="menu" role="menu">
          <label>
            读到
            <select
              value={toChapter === '' ? '' : String(toChapter)}
              onChange={(e) => onToChapterChange(e.target.value === '' ? '' : Number(e.target.value))}
              title="分析读到哪一章；只列正文章节"
            >
              <option value="">全部正文</option>
              {contentChapters.map((c) => (
                <option key={c.chapter_id} value={c.chapter_id}>
                  {c.title || `章节 ${c.chapter_id}`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            role="menuitem"
            disabled={!hasFailed}
            title={hasFailed ? '成功章节的结果保留，只读失败或未读完的章' : '没有失败章节'}
            onClick={() => run(false)}
          >
            只补读失败章节
          </button>
          <button type="button" role="menuitem" onClick={() => run(true)}>
            全部重读
          </button>
          <div className="hint">默认复用仍有效的章节结果，只读改动过的章</div>
          <hr />
          <button
            type="button"
            role="menuitem"
            disabled={!canExport || exporting}
            title="下载 JSON：人名册、势力、图与各章结果；章节聚焦时按所选范围导出"
            onClick={() => {
              setOpen(false)
              void onExport()
            }}
          >
            {exporting ? '导出中…' : '导出 JSON'}
          </button>
        </div>
      )}
    </div>
  )
}

const THEME_ICON = { system: '◐', light: '☀', dark: '☾' } as const

/** 主题切换：跟随系统 → 浅色 → 深色 循环 */
function ThemeToggle() {
  const { pref, cycle } = useTheme()
  return (
    <button
      type="button"
      className="btn ghost theme-toggle"
      onClick={cycle}
      title={`主题：${THEME_LABEL[pref]}（点击切换）`}
      aria-label={`主题：${THEME_LABEL[pref]}`}
    >
      {THEME_ICON[pref]}
    </button>
  )
}
