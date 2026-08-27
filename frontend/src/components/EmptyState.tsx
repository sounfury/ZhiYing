import type { FormEvent } from 'react'
import type { BookMeta } from '../api'
import { statusLabel } from '../labels'

interface EmptyStateProps {
  books: BookMeta[]
  onSelectBook: (bookId: string) => void
  onUpload: (file: File | null) => void
}

/**
 * 未选书时的画布：平静的上传 / 选书入口，不再偷偷挑一本演示 UUID。
 */
export function EmptyState({ books, onSelectBook, onUpload }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <p className="empty-kicker">织影</p>
      <h2>把电子书织成人物关系图</h2>
      <p className="empty-lead">
        先建人名册，再按章入账。关系多标签共存，软硬有权重——像读一本可以翻开的人物谱。
      </p>

      <label className="btn primary file-btn empty-upload">
        上传 EPUB
        <input
          type="file"
          accept=".epub"
          hidden
          onChange={(e: FormEvent<HTMLInputElement>) => {
            void onUpload(e.currentTarget.files?.[0] ?? null)
            e.currentTarget.value = ''
          }}
        />
      </label>

      {books.length > 0 && (
        <div className="empty-shelf">
          <p className="empty-shelf-label">已在案头的书</p>
          <ul>
            {books.map((b) => (
              <li key={b.book_id}>
                <button type="button" onClick={() => onSelectBook(b.book_id)}>
                  <strong>{b.title || '未题名'}</strong>
                  <span>
                    {b.author || '未知作者'} · {b.total_chapters} 章 · {statusLabel(b.status)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
