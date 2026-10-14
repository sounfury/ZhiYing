/** 反馈接口与选项：保存提交快照，后台只读取反馈并导出 JSONL。 */
import { apiFetch, readError, request } from '../api'

export const FEEDBACK_CATEGORIES = {
  DUPLICATE_PERSON: '人物重复', WRONG_RELATION: '关系错误', WRONG_GROUP: '势力不对', MISSING: '缺了人或关系', OTHER: '其他',
}
export type FeedbackCategory = keyof typeof FEEDBACK_CATEGORIES
export type FeedbackTarget = { targetKind: 'PERSON' | 'RELATION' | 'GROUP' | 'GENERAL'; targetRef?: string; targetLabel?: string }
export type FeedbackInput = FeedbackTarget & { revisionId?: string; scope?: string; category?: FeedbackCategory; note?: string }
export type Feedback = {
  id: string; createdAt: string; userId: string
  itemId: string | null; bookId: string | null; bookTitle: string | null; revisionId: string | null
  targetKind: FeedbackTarget['targetKind']; targetRef: string | null; targetLabel: string | null
  category: FeedbackCategory | null; note: string | null; scope: string | null
}
export type AdminFeedback = { feedback: Feedback; exampleSlug: string | null; targetExists: boolean }

export const submitFeedback = (itemId: string | null, input: FeedbackInput) => request<void>(
  itemId ? `/api/books/${encodeURIComponent(itemId)}/feedback` : '/api/feedback',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
)
export const getFeedback = () => request<AdminFeedback[]>('/api/admin/feedback')
export async function exportFeedback(book: string) {
  const res = await apiFetch(`/api/admin/feedback/export${book ? `?${new URLSearchParams({ book })}` : ''}`)
  if (!res.ok) throw new Error(await readError(res))
  const url = URL.createObjectURL(await res.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = 'feedback.jsonl'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
