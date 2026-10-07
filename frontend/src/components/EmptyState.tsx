/** 未选书时的画布：介绍一句，拖放上传 EPUB，并列出书架上已有的书供直接打开。 */
import type { BookMeta } from '../api'
import { formatWords, shortTitle, statusIsWarn, statusLabel } from '../labels'
import { coverGradient } from '../bookCover'
import { EpubDropZone } from './EpubDropZone'

interface EmptyStateProps {
  books: BookMeta[]
  onSelectBook: (bookId: string) => void
  onUpload: (file: File | null) => Promise<void>
}

export function EmptyState({ books, onSelectBook, onUpload }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <p className="empty-kicker">织影 ZHIYING</p>
      <h2>把一本小说织成人物关系图</h2>
      <p className="empty-lead">
        导入 EPUB，系统逐章阅读、自动归并人物与关系，出图后可按章节翻看、点人物看原文依据。
      </p>

      <EpubDropZone onUpload={onUpload} className="empty-drop" />

      {books.length > 0 && (
        <div className="empty-shelf">
          <p className="empty-shelf-label">书架上的书</p>
          {books.map((b) => {
            const title = shortTitle(b.title || '未题名')
            return (
              <button key={b.book_id} type="button" className="bk" onClick={() => onSelectBook(b.book_id)} title={b.title}>
                <span className="cover" style={{ background: coverGradient(b.title) }}>
                  {title.slice(0, 8)}
                </span>
                <span className="bk-body">
                  <h4>{title}</h4>
                  <p>
                    {[b.author || '未知作者', b.total_words ? formatWords(b.total_words) : ''].filter(Boolean).join(' · ')}
                  </p>
                  <p>
                    <span className={`pill${statusIsWarn(b.status) ? ' warn' : ''}`}>{statusLabel(b.status)}</span>
                  </p>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
