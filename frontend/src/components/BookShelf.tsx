/**
 * 书架抽屉：从左侧滑出，列出所有书（封面色块、作者、章数字数、状态、用量），点书切换，底部拖放上传；Esc 或点遮罩关闭。
 * 每本书可清空分析或删除（PRD §5.10），先弹窗确认；分析中两者都不可用。TXT 书可预览并改选分章方案（会清空分析）。
 */
import { useEffect, useRef, useState } from 'react'
import { apiUrl, getSplitPreview, getUsage, type BookMeta, type PersonalUsage, type SplitPreview } from '../api'
import { formatTokens, formatWords, shortTitle, statusIsWarn, statusLabel } from '../labels'
import { coverGradient } from '../bookCover'
import { EpubDropZone } from './EpubDropZone'

interface BookShelfProps {
  open: boolean
  books: BookMeta[]
  publicOnly: boolean
  isAdmin: boolean
  userId?: string
  onLogin: () => void
  bookId: string
  onClose: () => void
  onSelect: (bookId: string) => void
  onUpload: (file: File | null) => Promise<void>
  onDelete: (bookId: string) => Promise<void>
  onClearAnalysis: (bookId: string, rule?: string) => Promise<void>
}

export function BookShelf({ open, books, publicOnly, isAdmin, userId, onLogin, bookId, onClose, onSelect, onUpload, onDelete, onClearAnalysis }: BookShelfProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [usage, setUsage] = useState<PersonalUsage | null>(null)
  const [usageError, setUsageError] = useState('')

  useEffect(() => {
    if (!open || publicOnly || !userId) return
    let active = true
    setUsage(null)
    setUsageError('')
    void getUsage().then((data) => {
      if (active) setUsage(data)
    }).catch((error: unknown) => {
      if (active) setUsageError(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false }
  }, [open, publicOnly, userId, books])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <div className="shelf" hidden={!open}>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="书架">
        <h2>
          书架
          <button ref={closeRef} type="button" className="btn ghost" onClick={onClose} aria-label="关闭书架">
            ✕
          </button>
        </h2>
        {!publicOnly && usage && (usage.books.limit > 0 || usage.chars.limit > 0) && <p className="hint" aria-label="本人用量">
          {[
            usage.books.limit > 0 ? `书数 ${usage.books.used} / ${usage.books.limit} 本` : '',
            usage.chars.limit > 0 ? `分析字数 ${usage.chars.used.toLocaleString()} / ${usage.chars.limit.toLocaleString()} 字` : '',
          ].filter(Boolean).join(' · ')}
        </p>}
        {!publicOnly && usageError && <p className="hint" role="alert">用量读取失败：{usageError}</p>}
        <div className="shelf-list">
          {books.length === 0 && <p className="hint">{publicOnly ? '示例书正在准备中，请稍后再来。' : '书架还是空的，拖一本 EPUB 进来吧。'}</p>}
          {[
            { title: '示例', books: books.filter((b) => b.example_slug) },
            { title: '我的书', books: books.filter((b) => !b.example_slug) },
          ].filter((group) => group.books.length > 0).map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3>{group.title}</h3>
              {group.books.map((b) => (
            <BookCard
              key={b.book_id}
              book={b}
              current={b.book_id === bookId}
              onClick={() => {
                if (b.book_id !== bookId) onSelect(b.book_id)
                onClose()
              }}
              onDelete={() => void onDelete(b.book_id)}
              onClearAnalysis={() => void onClearAnalysis(b.book_id)}
              onResplit={(rule) => void onClearAnalysis(b.book_id, rule)}
            />
              ))}
            </section>
          ))}
        </div>
        {!publicOnly && <EpubDropZone
          onUpload={async (f) => {
            await onUpload(f)
            onClose()
          }}
        />}
        {publicOnly && <div>
          <p className="hint">上传自己的书需要登录，并凭邀请码注册。</p>
          <button type="button" className="btn primary" onClick={() => { onClose(); onLogin() }}>登录后上传</button>
        </div>}
        {isAdmin && <a className="shelf-eval hint" href={apiUrl('/admin')}>
          后台 →
        </a>}
      </aside>
    </div>
  )
}

interface BookCardProps {
  book: BookMeta
  current: boolean
  onClick: () => void
  onDelete: () => void
  onClearAnalysis: () => void
  onResplit: (rule: string) => void
}

function BookCard({ book, current, onClick, onDelete, onClearAnalysis, onResplit }: BookCardProps) {
  const [rules, setRules] = useState<SplitPreview[] | null>(null)
  const [rulesError, setRulesError] = useState('')
  const title = shortTitle(book.title || '未题名')
  const chapters = book.analysis_chapter_count || book.total_chapters
  const meta = [
    book.author || '未知作者',
    chapters ? `${chapters} 章${book.analysis_chapter_count ? '正文' : ''}` : '',
    book.total_words ? formatWords(book.total_words) : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const tokens = book.token_usage?.total_tokens
  const fullTitle = book.title || '未题名'
  const running = book.status === 'analyzing' || book.status === 'reconciling'
  const busyHint = running ? '正在分析，先停止分析' : undefined

  const confirmClear = () => {
    const ok = window.confirm(
      `清空「${fullTitle}」的分析结果？

关系图、各章结果与任务记录都会清除，不可恢复。已用分析额度不退还；再次分析会从头读每一章，重新消耗 token。`,
    )
    if (ok) onClearAnalysis()
  }
  const confirmDelete = () => {
    const ok = window.confirm(
      `删除「${fullTitle}」？

书、章节与全部分析结果都会删除，不可恢复；已用分析额度不退还。要再分析须重新上传。`,
    )
    if (ok) onDelete()
  }
  const toggleRules = () => {
    if (rules) {
      setRules(null)
      return
    }
    setRulesError('')
    getSplitPreview(book.book_id).then(setRules, (e: unknown) => setRulesError(e instanceof Error ? e.message : String(e)))
  }
  const chooseRule = (r: SplitPreview) => {
    const warn = book.status === 'uploaded' ? '' : '\n\n会清空现有分析结果，不可恢复；已用分析额度不退还。'
    if (!window.confirm(`把「${fullTitle}」改按「${r.name}」分章（${r.chapter_count} 章）？${warn}`)) return
    setRules(null)
    onResplit(r.id)
  }

  return (
    <div className={`bk${current ? ' cur' : ''}`}>
      <button
        type="button"
        className="bk-main"
        onClick={onClick}
        title={book.title}
        aria-current={current ? 'true' : undefined}
      >
        <span className="cover" style={{ background: coverGradient(book.title) }}>
          {title.slice(0, 8)}
        </span>
        <span className="bk-body">
          <h4>{title}</h4>
          <p>{meta}</p>
          <p>
            <span className={`pill${statusIsWarn(book.status) ? ' warn' : ''}`}>{statusLabel(book.status)}</span>
            {tokens ? <span className="bk-tokens">{formatTokens(tokens)} token</span> : null}
          </p>
          {book.split_rule === 'length' && <p className="hint">未识别到章节标题，已按长度分段</p>}
        </span>
      </button>
      {rulesError && <p className="hint" role="alert">分章预览失败：{rulesError}</p>}
      {rules && <ul className="hint" aria-label="分章方案">
        {rules.map((r) => (
          <li key={r.id}>
            <button type="button" className="btn ghost" disabled={r.current || r.chapter_count === 0} onClick={() => chooseRule(r)}>
              {r.name} · {r.chapter_count} 章{r.current ? '（当前）' : ''}
            </button>
            <div>{[r.beginning, r.middle, r.end].filter((t) => t.length > 0).map((t) => t.join('、')).join(' … ')}</div>
          </li>
        ))}
      </ul>}
      {!book.example_slug && <div className="bk-actions">
        {book.split_rule && <button
          type="button"
          className="btn ghost"
          onClick={toggleRules}
          disabled={running}
          title={busyHint ?? '预览并改选 TXT 分章方案'}
        >
          {rules ? '收起分章' : '换分章'}
        </button>}
        <button
          type="button"
          className="btn ghost"
          onClick={confirmClear}
          disabled={running || book.status === 'uploaded'}
          title={busyHint ?? (book.status === 'uploaded' ? '还没有分析结果' : '清除分析结果，书保留')}
        >
          清空分析
        </button>
        <button
          type="button"
          className="btn ghost danger"
          onClick={confirmDelete}
          disabled={running}
          title={busyHint ?? '删除这本书及全部数据'}
        >
          删除
        </button>
      </div>}
    </div>
  )
}
