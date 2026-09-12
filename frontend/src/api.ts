/** Thin client for ZhiYing backend (via Vite proxy → :8000). */

export type BookMeta = {
  book_id: string
  title: string
  author: string
  total_chapters: number
  status: string
  factions_stale?: boolean
  analysis_progress?: {
    chapters_done: number[]
    chapters_failed?: number[]
    chapters_partial?: number[]
    chapters_pending?: number[]
    reconcile_done: boolean
  }
}

export type GraphEvidence = {
  chapter_id: number
  quote: string
}

export type RelationDescriptor = {
  label: string
  category: string
  definition: string
  directed: boolean
  subject_role: string
  object_role: string
}

export type GraphTag = RelationDescriptor & {
  key: string
  predicate: string | null
  normalization_status: 'pending' | 'resolved'
  relation_ids: string[]
  raw_relations: string[]
  chapter_ids: number[]
  evidences: GraphEvidence[]
  display_score: number
}

export type GraphEdge = {
  person_a: string
  person_b: string
  tags: GraphTag[]
}

export type GraphNode = {
  person_id: string
  name: string
  aliases: string[]
  gender: string
  importance: string
  appearance_count: number
  bio: string
  /** 全部势力归属（可多归属） */
  faction_ids: string[]
  /** 布局落块用的主势力；null = 未归属 */
  primary_faction_id: string | null
  /** 归属由邻居传播推断而来，非 LLM 显式抽取 */
  faction_inferred: boolean
}

export type GraphFaction = {
  faction_id: string
  name: string
  kind: string
  /** 环形排列序：相邻块共享桥接人物更多 */
  order: number
  /** 主势力落在此块的成员（布局按此装填） */
  member_ids: string[]
  /** 含次要归属的全部成员 */
  all_member_ids: string[]
  inferred: boolean
  needs_review: string[]
}

export type GraphData = {
  book_id: string
  chapter_range: number[]
  total_chapters: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  factions: GraphFaction[]
  filtered_count: number
  pending_relation_count?: number
  rejected_relation_count?: number
  unclassified_relation_count?: number
  filtered_persons: { person_id: string; name: string }[]
}

export type AnalyzeStartResult = {
  status: string
  mode?: string
  total_chapters: number
  task_id?: string
}

export type AnalysisTaskChapter = {
  chapter_id: number
  status: string
  attempts: number
  last_error: string
}

export type AnalysisTaskSnapshot = {
  task_id?: string
  active: boolean
  status: string
  phase: string
  total_chapters?: number
  chapters: AnalysisTaskChapter[]
  llm_requests?: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  stop_reason?: string
}

export type ProgressEvent = {
  chapter_id?: number
  done?: number
  total?: number
  processed?: number
  batch?: number
  batches?: number
  model_candidates?: number
  warnings?: number
  pending?: number
  status?: string
  error?: string
  reason?: string
  phase?: string
  failed_chapters?: number[]
  retry_queued?: number[]
  retry_chapters?: number[]
  retry?: boolean
  success_count?: number
  failure_count?: number
  running_count?: number
  queued_count?: number
  kind?: string
  context?: string
  elapsed_ms?: number
  request_no?: number
  attempt?: number
  delay_seconds?: number
  llm_requests?: number
  total_tokens?: number
  stop_requested?: boolean
  tools?: string[]
  step?: number
  max_steps?: number
}

export type DoneEvent = {
  chapters_done: number
  chapters_failed: number
  chapters_done_ids?: number[]
  chapters_failed_ids?: number[]
  chapters_partial_ids?: number[]
  stopped?: boolean
  reconcile_done?: boolean
  phase?: string
  status?: string
  degraded?: boolean
  errors?: { chapter_id: number; error: string }[]
  total?: number
  error?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.message || body.detail || JSON.stringify(body)
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}: ${detail}`)
  }
  return res.json() as Promise<T>
}

export async function listBooks(): Promise<BookMeta[]> {
  const data = await request<{ books: BookMeta[] }>('/api/books')
  return data.books ?? []
}

export function getBook(bookId: string): Promise<BookMeta> {
  return request<BookMeta>(`/api/books/${bookId}`)
}

export type ChapterBrief = {
  chapter_id: number
  title: string
  order: number
  word_count: number
  include_in_analysis: boolean
}

/** Chapters with real book content intended for analysis (导读/年表等会标 false). */
export async function listChapters(bookId: string): Promise<ChapterBrief[]> {
  const data = await request<{ chapters: ChapterBrief[] }>(
    `/api/books/${bookId}/chapters`,
  )
  return data.chapters ?? []
}

export function analysisChapters(chapters: ChapterBrief[]): ChapterBrief[] {
  return chapters
    .filter((c) => c.include_in_analysis)
    .sort((a, b) => a.order - b.order)
}

export type GraphQuery = {
  to_chapter?: number
  /** true = 仅该章；false/缺省 = 1..to_chapter 累计 */
  single_chapter?: boolean
  min_appearance?: number
  predicate_filter?: string
  category_filter?: string
}

export function getGraph(bookId: string, q: GraphQuery = {}): Promise<GraphData> {
  const params = new URLSearchParams()
  if (q.to_chapter != null) params.set('to_chapter', String(q.to_chapter))
  if (q.single_chapter) params.set('single_chapter', 'true')
  if (q.min_appearance != null) params.set('min_appearance', String(q.min_appearance))
  if (q.category_filter) params.set('category_filter', q.category_filter)
  if (q.predicate_filter) params.set('predicate_filter', q.predicate_filter)
  const qs = params.toString()
  return request<GraphData>(`/api/books/${bookId}/graph${qs ? `?${qs}` : ''}`)
}

export type FactionExtractResult = {
  status: string
  version: number
  factions: number
  members: number
  steps_used: number
}

/** 跑一次势力归纳（单次 LLM 会话，几十秒级，会覆盖 factions.json） */
export function extractFactions(bookId: string): Promise<FactionExtractResult> {
  return request<FactionExtractResult>(`/api/books/${bookId}/factions`, {
    method: 'POST',
  })
}

export function startAnalysis(  bookId: string,
  toChapter?: number,
): Promise<AnalyzeStartResult> {
  const params = new URLSearchParams()
  if (toChapter != null) params.set('to_chapter', String(toChapter))
  const qs = params.toString()
  return request<AnalyzeStartResult>(`/api/books/${bookId}/analyze${qs ? `?${qs}` : ''}`, {
    method: 'POST',
  })
}

export function getAnalysisTask(bookId: string): Promise<AnalysisTaskSnapshot> {
  return request<AnalysisTaskSnapshot>(`/api/books/${bookId}/analysis/task`)
}

export function retryFailedChapters(bookId: string, chapterIds?: number[]): Promise<{ status: string; queued: number[]; ignored: number[] }> {
  return request(`/api/books/${bookId}/analyze/retry-failed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapter_ids: chapterIds ?? null }),
  })
}

export function skipFailedChapters(bookId: string): Promise<{ status: string; chapters: number[] }> {
  return request(`/api/books/${bookId}/analyze/skip-failed`, { method: 'POST' })
}

export async function stopAnalysis(bookId: string): Promise<{ status: string }> {
  return request(`/api/books/${bookId}/analyze/stop`, { method: 'POST' })
}

export async function uploadBook(file: File): Promise<{ book_id: string; title: string }> {
  const form = new FormData()
  form.append('file', file)
  return request('/api/books/upload', { method: 'POST', body: form })
}

/**
 * Subscribe to analysis SSE. Returns an unsubscribe function.
 * Must be called soon after startAnalysis so queued events are drained.
 */
export function subscribeAnalysisProgress(
  bookId: string,
  handlers: {
    onProgress?: (data: ProgressEvent) => void
    onDone?: (data: DoneEvent) => void
    onError?: (message: string) => void
  },
): () => void {
  const es = new EventSource(`/api/books/${bookId}/progress`)
  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    es.close()
  }

  es.addEventListener('progress', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as ProgressEvent
      handlers.onProgress?.(data)
    } catch (e) {
      handlers.onError?.(e instanceof Error ? e.message : String(e))
    }
  })

  es.addEventListener('done', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as DoneEvent
      handlers.onDone?.(data)
    } catch (e) {
      handlers.onError?.(e instanceof Error ? e.message : String(e))
    } finally {
      close()
    }
  })

  es.onerror = () => {
    // EventSource auto-reconnects; if server closed after done we already closed.
    if (closed) return
    // Don't spam: only surface once after a delay if still open
    handlers.onError?.('SSE 连接异常（可能后端已断开，将尝试重连…）')
  }

  return close
}

// ── Cast / 人名册 ──

export type CastAlias = {
  name: string
  frequency: string
}

export type CastPerson = {
  person_id: string
  canonical_name: string
  aliases: CastAlias[]
  bio: string
  gender: string
  importance: string
  merge_candidates: string[]
}

export type Cast = {
  version: number
  persons: CastPerson[]
}

export function getCast(bookId: string): Promise<Cast> {
  return request<Cast>(`/api/books/${bookId}/cast`)
}

export function putCast(bookId: string, body: Cast): Promise<Cast> {
  return request<Cast>(`/api/books/${bookId}/cast`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function mergeCastPersons(
  bookId: string,
  keepId: string,
  dropId: string,
): Promise<Cast> {
  return request<Cast>(`/api/books/${bookId}/cast/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keep_id: keepId, drop_id: dropId }),
  })
}

// ── Chapter ledger / 单章账本 ──

export type LedgerEvidence = {
  chapter_id: number
  quote: string
  note: string
  quote_verified: boolean | null
}

export type LedgerRelation = RelationDescriptor & {
  relation_id: string
  raw_relation: string
  predicate: string | null
  normalization_status: 'pending' | 'resolved'
  normalization_reason: string
  status: 'pending' | 'confirmed' | 'rejected'
  verification_reason: string
  person_a: string
  person_b: string
  evidence: LedgerEvidence
}

export type LedgerPerson = {
  person_id: string
  aliases_in_chapter: string[]
}

export type LedgerEvent = {
  description: string
  persons: string[]
}

export type ChapterLedger = {
  analysis_status?: 'complete' | 'partial'
  warnings?: string[]
  chapter_id: number
  persons: LedgerPerson[]
  relations: LedgerRelation[]
  events: LedgerEvent[]
  summary: string
}

export function getChapterLedger(
  bookId: string,
  chapterId: number,
): Promise<ChapterLedger> {
  return request<ChapterLedger>(`/api/books/${bookId}/chapters/${chapterId}/result`)
}

export type RerunResult = {
  partial?: boolean
  warnings?: string[]
  status: string
  chapter_id: number
  success: boolean
  steps_used: number
  reconcile_done?: boolean
  reconcile_degraded?: boolean
  reconcile_warning?: string
  factions?: number
  factions_stale?: boolean
}

export function rerunChapter(bookId: string, chapterId: number): Promise<RerunResult> {
  return request<RerunResult>(`/api/books/${bookId}/chapters/${chapterId}/rerun`, {
    method: 'POST',
  })
}

// ── Export ──

async function readError(res: Response): Promise<string> {
  let detail = res.statusText
  try {
    const body = await res.json()
    detail = body.message || body.detail || JSON.stringify(body)
  } catch {
    /* ignore */
  }
  return `${res.status}: ${detail}`
}

/**
 * GET /export → JSON bundle (meta / cast / factions / overrides / graph / ledgers).
 * Triggers a browser download using Content-Disposition when present.
 */
export async function downloadExport(bookId: string): Promise<string> {
  const res = await fetch(`/api/books/${bookId}/export`)
  if (!res.ok) throw new Error(await readError(res))
  const blob = await res.blob()
  const cd = res.headers.get('Content-Disposition') ?? ''
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd)
  const filename = decodeURIComponent(match?.[1]?.replace(/"/g, '') ?? `zhiying-${bookId}.json`)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return filename
}

// ── Relation type meta ──

export type RelationTypeMeta = RelationDescriptor & {
  predicate: string
  aliases: string[]
  display_priority: number
}

export async function getRelationTypes(bookId: string): Promise<RelationTypeMeta[]> {
  const data = await request<{ relation_types: RelationTypeMeta[] }>(
    `/api/books/${bookId}/relation-types`,
  )
  return data.relation_types
}
