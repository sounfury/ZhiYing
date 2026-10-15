/** 对象与通用反馈入口：登录后点选类别、补充说明，按点击时的版本与范围提交，不改图。 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { useAppState } from '../state/useAppState'
import { useAuth } from '../useAuth'
import { FEEDBACK_CATEGORIES, submitFeedback, type FeedbackCategory, type FeedbackInput, type FeedbackTarget } from './feedbackApi'
import '../components/account.css'
import './feedback.css'

type Submission = { itemId: string | null; input: FeedbackInput }
type Kind = FeedbackTarget['targetKind']

const MAX_NOTE = 200
const KIND_LABEL: Record<Kind, string> = { PERSON: '人物', RELATION: '关系', GROUP: '势力', GENERAL: '整个产品' }
/** 各对象只给相关的类别；通用反馈全部可选 */
const KIND_CATEGORIES: Record<Kind, FeedbackCategory[]> = {
  PERSON: ['DUPLICATE_PERSON', 'WRONG_GROUP', 'MISSING', 'OTHER'],
  RELATION: ['WRONG_RELATION', 'MISSING', 'OTHER'],
  GROUP: ['WRONG_GROUP', 'MISSING', 'OTHER'],
  GENERAL: Object.keys(FEEDBACK_CATEGORIES) as FeedbackCategory[],
}
const PLACEHOLDER: Record<FeedbackCategory | '', string> = {
  DUPLICATE_PERSON: '和谁是同一个人？例如：「三哥」就是张三',
  WRONG_RELATION: '应该是什么关系？例如：是师徒，不是父子',
  WRONG_GROUP: '应该属于哪一方？',
  MISSING: '缺了谁，或缺了哪段关系？',
  OTHER: '说说哪里不对',
  '': '补一句说明，方便我们定位问题（可选）',
}

/** 旗子：标记「这里不对」 */
function FlagIcon() {
  return <svg className="feedback-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M3.5 14.5V2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M3.5 2.5h8.2a.5.5 0 0 1 .4.8L10.4 6l1.7 2.7a.5.5 0 0 1-.4.8H3.5" fill="currentColor" fillOpacity=".18" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
}

/** 对话气泡：产品反馈 */
function BubbleIcon() {
  return <svg className="feedback-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5Z" fill="currentColor" fillOpacity=".18" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M5.5 6.75h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
}

/** compact：只显示图标，用在势力图例等密集处 */
export function FeedbackButton({ target, children = '这里不对', compact = false }: { target: FeedbackTarget; children?: string; compact?: boolean }) {
  const { user, openAccount } = useAuth()
  const { selectedBook, graph } = useAppState()
  const [submission, setSubmission] = useState<Submission | null>(null)
  const [received, setReceived] = useState(false)
  useEffect(() => {
    if (!received) return
    const timer = window.setTimeout(() => setReceived(false), 4000)
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
  const title = !ready ? '图谱加载完成后可反馈' : !user ? '登录后反馈' : general ? '反馈产品问题或建议' : `反馈：${target.targetLabel}有误`
  return <>
    <button type="button" className={`feedback-button${compact ? ' compact' : ''}`} disabled={!ready} title={title} aria-label={compact ? title : undefined} onClick={open}>
      {general ? <BubbleIcon /> : <FlagIcon />}{!compact && <span>{children}</span>}
    </button>
    {submission && <FeedbackDialog submission={submission} onClose={() => setSubmission(null)} onReceived={() => { setSubmission(null); setReceived(true) }} />}
    {received && <div className="feedback-toast" role="status">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor" /><path d="m5 8.2 2 2 4-4.2" fill="none" stroke="var(--accent-ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      已收到反馈，谢谢
      <button type="button" aria-label="关闭反馈提示" onClick={() => setReceived(false)}>✕</button>
    </div>}
  </>
}

/** 「single:3」→「第 3 章」，「upto:3」→「前 3 章」 */
function scopeLabel(scope?: string) {
  const [mode, chapter] = scope?.split(':') ?? []
  return mode === 'single' ? `第 ${chapter} 章` : mode === 'upto' ? `前 ${chapter} 章` : scope ? '全书' : ''
}

function FeedbackDialog({ submission, onClose, onReceived }: { submission: Submission; onClose: () => void; onReceived: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [category, setCategory] = useState<FeedbackCategory | ''>('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { input } = submission
  const general = input.targetKind === 'GENERAL'
  const length = [...note].length
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    if (busy) return
    if (length > MAX_NOTE) { setError(`说明不能超过 ${MAX_NOTE} 字`); return }
    setBusy(true)
    setError('')
    try {
      await submitFeedback(submission.itemId, { ...input, category: category || undefined, note: note.trim() || undefined })
      onReceived()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    e.stopPropagation()
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit() }
  }
  // 点遮罩关闭；已写了说明时不关，免得误点丢字
  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget && !busy && !note.trim()) onClose()
  }
  const scope = scopeLabel(input.scope)
  return <dialog ref={dialog} className="account-dialog feedback-dialog" aria-labelledby="feedback-title" onCancel={(e) => { if (busy) e.preventDefault(); else onClose() }} onKeyDown={onKeyDown} onClick={onBackdrop}>
    <div className="account-heading">
      <h2 id="feedback-title">{general ? <BubbleIcon /> : <FlagIcon />}{general ? '产品反馈' : '这里不对'}</h2>
      <button type="button" className="btn ghost" aria-label="关闭反馈窗口" disabled={busy} onClick={onClose}>✕</button>
    </div>
    {!general && <div className="feedback-target">
      <span className="pill">{KIND_LABEL[input.targetKind]}</span>
      <strong>{input.targetLabel}</strong>
      {scope && <span className="hint">· {scope}</span>}
    </div>}
    <form className="feedback-form" onSubmit={(e) => void submit(e)}>
      <fieldset disabled={busy}>
        <legend>{general ? '是哪方面的问题？' : '哪里不对？'}<span className="hint">（可选）</span></legend>
        <div className="feedback-chips">{KIND_CATEGORIES[input.targetKind].map((key) => <label key={key} className={category === key ? 'on' : ''}>
          <input type="radio" name="feedback-category" value={key} checked={category === key} onChange={() => setCategory(key)} onClick={() => { if (category === key) setCategory('') }} />
          {FEEDBACK_CATEGORIES[key]}
        </label>)}</div>
      </fieldset>
      <label className="feedback-note">
        <textarea aria-label="补充说明" rows={4} autoFocus value={note} disabled={busy} placeholder={PLACEHOLDER[category]} aria-describedby="feedback-count" onChange={(e) => setNote(e.target.value)} />
        <span id="feedback-count" className={`feedback-count${length > MAX_NOTE ? ' over' : ''}`}>{length} / {MAX_NOTE}</span>
      </label>
      {error && <p className="account-error" role="alert">{error}</p>}
      <div className="feedback-foot">
        <span className="hint">反馈只用于改进分析，不会改动你的图谱。</span>
        <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="btn primary" disabled={busy} title="Ctrl / ⌘ + Enter">{busy ? '正在提交…' : '提交'}</button>
      </div>
    </form>
  </dialog>
}
