/** Thin client for ZhiYing backend (via Vite proxy → :8000). */

export type BookMeta = {
  book_id: string
  title: string
  author: string
  total_chapters: number
  status: string
  analysis_progress?: {
    chapters_done: number[]
    chapters_failed?: number[]
    chapters_pending?: number[]
    reconcile_done: boolean
  }
}

export type GraphEvidence = {
  chapter_id: number
  quote: string
}

export type GraphTag = {
  type: string
  tier: string
  directed: boolean
  chapter_ids: number[]
  evidences: GraphEvidence[]
  display_score: number
  suppressed: boolean
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
}

export type GraphData = {
  book_id: string
  chapter_range: number[]
  total_chapters: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  filtered_count: number
  filtered_persons: { person_id: string; name: string }[]
}

export type AnalyzeStartResult = {
  status: string
  mode?: string
  total_chapters: number
}

export type ProgressEvent = {
  chapter_id?: number
  done?: number
  total?: number
  status?: string
  error?: string
  phase?: string
}

export type DoneEvent = {
  chapters_done: number
  chapters_failed: number
  chapters_done_ids?: number[]
  chapters_failed_ids?: number[]
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
  type_filter?: string
  include_suppressed?: boolean
}

export function getGraph(bookId: string, q: GraphQuery = {}): Promise<GraphData> {
  const params = new URLSearchParams()
  if (q.to_chapter != null) params.set('to_chapter', String(q.to_chapter))
  if (q.single_chapter) params.set('single_chapter', 'true')
  if (q.min_appearance != null) params.set('min_appearance', String(q.min_appearance))
  if (q.type_filter) params.set('type_filter', q.type_filter)
  if (q.include_suppressed) params.set('include_suppressed', 'true')
  const qs = params.toString()
  return request<GraphData>(`/api/books/${bookId}/graph${qs ? `?${qs}` : ''}`)
}

export function startAnalysis(
  bookId: string,
  toChapter?: number,
): Promise<AnalyzeStartResult> {
  const params = new URLSearchParams()
  if (toChapter != null) params.set('to_chapter', String(toChapter))
  const qs = params.toString()
  return request<AnalyzeStartResult>(`/api/books/${bookId}/analyze${qs ? `?${qs}` : ''}`, {
    method: 'POST',
  })
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
