/** 对象与通用反馈入口：登录后可选类别和说明，按点击时的版本与范围提交，不改图。 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAppState } from '../state/useAppState'
import { useAuth } from '../useAuth'
import { FEEDBACK_CATEGORIES, submitFeedback, type FeedbackCategory, type FeedbackInput, type FeedbackTarget } from './feedbackApi'
import '../components/account.css'
import './feedback.css'

type Submission = { itemId: string | null; input: FeedbackInput }

export function FeedbackButton({ target, children = '这里不对' }: { target: FeedbackTarget; children?: string }) {
  const { user, openAccount } = useAuth()
  const { selectedBook, graph } = useAppState()
  const [submission, setSubmission] = useState<Submission | null>(null)
  const [received, setReceived] = useState(false)
  useEffect(() => {
    if (!received) return
    const timer = window.setTimeout(() => setReceived(false), 6000)
    return () => window.clearTimeout(timer)
  }, [received])
  const general = target.targetKind === 'GENERAL'
  const ready = general || !!(selectedBook && graph?.book_id === selectedBook.book_id && graph.revision_id)
  const open = () => {
    if (!user) { openAccount('login'); return }
    setReceived(false)
    if (general) {
      setSubmission({ itemId: null, input: target })
      return
    }
    if (!selectedBook || graph?.book_id !== selectedBook.book_id || !graph.revision_id) return
    const focus = graph.chapter_focus
    setSubmission({
      itemId: selectedBook.book_id,
      input: { ...target, revisionId: graph.revision_id, scope: focus ? `${focus.mode}:${focus.chapter}` : 'all' },
    })
  }
  return <>
    <button type="button" className="btn ghost feedback-button" disabled={!ready} title={user ? `反馈：${target.targetLabel ?? '整个产品'}` : '请先登录后反馈'} onClick={open}>{children}</button>
    {submission && <FeedbackDialog submission={submission} onClose={() => setSubmission(null)} onReceived={() => { setSubmission(null); setReceived(true) }} />}
    {received && <div className="feedback-toast" role="status">已收到<button type="button" aria-label="关闭反馈提示" onClick={() => setReceived(false)}>✕</button></div>}
  </>
}

function FeedbackDialog({ submission, onClose, onReceived }: { submission: Submission; onClose: () => void; onReceived: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [category, setCategory] = useState<FeedbackCategory | ''>('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    if ([...note].length > 200) { setError('说明不能超过 200 字'); return }
    setBusy(true)
    setError('')
    try {
      await submitFeedback(submission.itemId, { ...submission.input, category: category || undefined, note: note.trim() || undefined })
      onReceived()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return <dialog ref={dialog} className="account-dialog" aria-labelledby="feedback-title" onCancel={(e) => { if (busy) e.preventDefault(); else onClose() }} onKeyDown={(e) => e.stopPropagation()}>
    <div className="account-heading"><h2 id="feedback-title">{submission.input.targetKind === 'GENERAL' ? '产品反馈' : '这里不对'}</h2><button type="button" className="btn ghost" aria-label="关闭反馈窗口" disabled={busy} onClick={onClose}>✕</button></div>
    {submission.input.targetLabel && <p>{submission.input.targetLabel}</p>}
    <form className="account-form" onSubmit={(e) => void submit(e)}>
      <label>问题类别（可选）<select value={category} disabled={busy} onChange={(e) => setCategory(e.target.value as FeedbackCategory | '')}><option value="">不选类别</option>{Object.entries(FEEDBACK_CATEGORIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>补一句说明（可选，最多 200 字）<textarea rows={3} value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} /></label>
      {error && <p className="account-error" role="alert">{error}</p>}
      <button type="submit" className="btn primary" disabled={busy}>{busy ? '正在提交…' : '提交'}</button>
    </form>
    <p className="hint">反馈不会改变分析结果。</p>
  </dialog>
}
