/** 书架抽屉：从左侧滑出，列出所有书（封面色块、作者、章数字数、状态、用量），点书切换，底部拖放上传；Esc 或点遮罩关闭。 */
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
}

export function BookShelf({ open, books, bookId, onClose, onSelect, onUpload }: BookShelfProps) {
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
            />
          ))}
        </div>
        <EpubDropZone
          onUpload={async (f) => {
            await onUpload(f)
            onClose()
          }}
        />
      </aside>
    </div>
  )
}

function BookCard({ book, current, onClick }: { book: BookMeta; current: boolean; onClick: () => void }) {
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
  return (
    <button
      type="button"
      className={`bk${current ? ' cur' : ''}`}
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
  )
}
