/**
 * 书架抽屉：从左侧滑出，列出所有书（封面色块、作者、章数字数、状态、用量），点书切换，底部拖放上传；Esc 或点遮罩关闭。
 * 每本书可清空分析或删除（PRD §5.10），先弹窗确认；分析中两者都不可用。
 */
import { useEffect, useRef } from 'react'
import type { BookMeta } from '../api'
import { formatTokens, formatWords, shortTitle, statusIsWarn, statusLabel } from '../labels'
import { coverGradient } from '../bookCover'
import { EpubDropZone } from './EpubDropZone'

interface BookShelfProps {
  open: boolean
  books: BookMeta[]
  bookId: string
  onClose: () => void
  onSelect: (bookId: string) => void
  onUpload: (file: File | null) => Promise<void>
  onDelete: (bookId: string) => Promise<void>
  onClearAnalysis: (bookId: string) => Promise<void>
}

export function BookShelf({ open, books, bookId, onClose, onSelect, onUpload, onDelete, onClearAnalysis }: BookShelfProps) {
  const closeRef = useRef<HTMLButtonElement>(null)

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
        <div className="shelf-list">
          {books.length === 0 && <p className="hint">书架还是空的，拖一本 EPUB 进来吧。</p>}
          {books.map((b) => (
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
            />
          ))}
        </div>
        <EpubDropZone
          onUpload={async (f) => {
            await onUpload(f)
            onClose()
          }}
        />
        <a className="shelf-eval hint" href="/eval">
          评测（开发者工具）→
        </a>
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
}

function BookCard({ book, current, onClick, onDelete, onClearAnalysis }: BookCardProps) {
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

关系图、各章结果与用量记录都会清除，不可恢复。再次分析会从头读每一章，重新消耗 token。`,
    )
    if (ok) onClearAnalysis()
  }
  const confirmDelete = () => {
    const ok = window.confirm(
      `删除「${fullTitle}」？

书、章节与全部分析结果都会删除，不可恢复；要再分析须重新上传。`,
    )
    if (ok) onDelete()
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
        </span>
      </button>
      <div className="bk-actions">
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
      </div>
    </div>
  )
}
