/** 后台反馈页签：按书筛选、分组查看提交快照，仅公开示例书可定位，支持 JSONL 导出。 */
import { useEffect, useState } from 'react'
import { apiUrl } from '../api'
import { bookLink } from '../bookLinks'
import { ALL_BOOK_FOCUS } from '../types'
import { FEEDBACK_CATEGORIES, exportFeedback, getFeedback, type AdminFeedback } from '../feedback/feedbackApi'
import '../feedback/feedback.css'

function targetLink(row: AdminFeedback): string | null {
  if (!row.exampleSlug || !row.targetExists) return null
  const f = row.feedback
  const person = f.targetKind === 'PERSON' ? f.targetRef : f.targetKind === 'RELATION' ? f.targetRef?.split('/')[0] : null
  if (!person) return null
  return bookLink(new URL(apiUrl('/'), window.location.origin).toString(), { book_id: f.itemId!, example_slug: row.exampleSlug }, ALL_BOOK_FOCUS, person)
}

export default function FeedbackPanel() {
  const [rows, setRows] = useState<AdminFeedback[]>([])
  const [book, setBook] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)
  useEffect(() => {
    let cancelled = false
    getFeedback().then((data) => { if (!cancelled) setRows(data) })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])
  const books = new Map(rows.filter((row) => row.feedback.itemId).map((row) => [row.feedback.itemId!, row.feedback.bookTitle!]))
  const groups = new Map<string, AdminFeedback[]>()
  for (const row of rows) {
    if (book && row.feedback.itemId !== book) continue
    const key = row.feedback.itemId ?? ''
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  const download = async () => {
    setExporting(true)
    setError('')
    try { await exportFeedback(book) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setExporting(false) }
  }
  return <section className="admin-content" aria-label="反馈管理">
    <h2>反馈</h2>
    <div className="account-actions"><label>按书查看 <select value={book} onChange={(e) => setBook(e.target.value)}><option value="">全部反馈（含产品反馈）</option>{[...books].map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label><button type="button" className="btn" disabled={loading || exporting} onClick={() => void download()}>{exporting ? '正在导出…' : '导出 JSONL'}</button></div>
    {error && <p className="account-error" role="alert">{error}</p>}
    {loading ? <p role="status">正在加载反馈…</p> : groups.size === 0 ? <p>暂无反馈。</p> : [...groups].map(([id, group]) => <section key={id} className="feedback-list">
      <h3>{id ? group[0].feedback.bookTitle : '产品反馈'}</h3>
      {group.map((row) => {
        const f = row.feedback
        const link = targetLink(row)
        return <article key={f.id} className="feedback-record">
          <div><strong>{f.targetLabel || '整个产品'}</strong> · {f.category ? FEEDBACK_CATEGORIES[f.category] : '未选类别'}</div>
          {f.note && <p>{f.note}</p>}
          <p className="hint"><time dateTime={f.createdAt}>{new Date(f.createdAt).toLocaleString()}</time>{f.scope && ` · 范围：${f.scope}`}{f.revisionId && ` · 版本：${f.revisionId}`}</p>
          {link ? <a className="text-link" href={link}>查看当前结果 →</a> : row.exampleSlug && (f.targetKind === 'PERSON' || f.targetKind === 'RELATION') ? <p className="hint">该对象在当前结果中已不存在</p> : f.itemId && !row.exampleSlug ? <p className="hint">私有书仅显示反馈内容</p> : null}
        </article>
      })}
    </section>)}
  </section>
}
