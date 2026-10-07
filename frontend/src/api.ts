/** ZhiYing 后端客户端（经 Vite 代理到 Kotlin 后端 :8080）；新旧接口差异在本文件内转换，组件沿用原类型。 */

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
  /** 全书字数（含导读等非正文） */
  total_words?: number
  /** 参与分析的正文章数 */
  analysis_chapter_count?: number
  /** 本书累计模型用量（整书分析与单章重跑合计） */
  token_usage?: TokenUsage
}

export type TokenUsage = {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  llm_requests: number
}

export type GraphEvidence = {
  chapter_id: number
  quote: string
  /** 一句话说明（PRD §5.6）；旧数据缺省 */
  note?: string
}

/** 关系硬度：硬 / 中 / 软（PRD §5.5） */
export type Hardness = 'hard' | 'medium' | 'soft'

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
  /** 硬度档；旧数据缺省时按 category 推断 */
  hardness?: Hardness
  /** 有向关系的主语一方（subject_role 指它） */
  source_person_id?: string
  /** 该关系有聚焦章节的依据（仅章节聚焦响应带；旧数据缺省） */
  in_focus_chapter?: boolean
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
  /** 出场章节（与 ChapterBrief.chapter_id 同口径，按阅读顺序）；旧数据缺省 */
  chapter_ids?: number[]
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

/** 章节聚焦：single = 仅第 N 章；upto = 前 N 章累计 */
export type ChapterMode = 'single' | 'upto'

export type ChapterFocusParam = { chapter: number; mode: ChapterMode }

export type GraphData = {
  book_id: string
  /** 当前章节聚焦范围；null / 缺省 = 全书视图 */
  chapter_focus?: ChapterFocusParam | null
  chapter_range: number[]
  total_chapters: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  factions: GraphFaction[]
  filtered_count: number
  filtered_persons: { person_id: string; name: string }[]
}

export type AnalyzeStartResult = {
  status: string
  mode?: string
  total_chapters: number
  task_id?: string
}

/** 任务中的一章；chapter_id 为阅读序号（与 ChapterBrief.chapter_id 一致） */
export type AnalysisTaskChapter = {
  chapter_id: number
  title: string
  /** pending / running / done / partial（完成但有警告）/ failed / cancelled */
  status: string
  /** 沿用了已存的有效抽取，没有重新调用模型 */
  reused: boolean
  /** 长章分段：已读完段数 / 总段数（同章各段串行） */
  units_done: number
  units_total: number
  last_error: string
  warnings: string[]
}

/** 分析阶段：读章 → 后处理 → 团体归纳 → 发布（finished 为已结束；idle 为从未分析） */
export type AnalysisPhase =
  | 'idle'
  | 'preparing'
  | 'reading'
  | 'post_processing'
  | 'inducing_affiliations'
  | 'publishing'
  | 'finished'

/** GET /analysis/task：运行中为实时快照，否则为最近一次任务；从未分析过只有 active / status=idle / phase / chapters */
export type AnalysisTaskSnapshot = {
  task_id?: string
  /** full 整书分析 / rerun 单章重跑 */
  kind?: 'full' | 'rerun'
  active: boolean
  /** running / completed（已发布）/ failed（未发布）/ cancelled（未发布）/ idle */
  status: string
  phase: AnalysisPhase | string
  total_chapters?: number
  started_at?: string
  finished_at?: string | null
  revision_id?: string | null
  /** 终态说明，如「已发布：人物 81，关系记录 109」或失败原因与建议 */
  message?: string
  chapters: AnalysisTaskChapter[]
  success_count?: number
  failure_count?: number
  running_count?: number
  queued_count?: number
  llm_requests?: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

/** SSE progress：章级变化带该章字段，阶段切换只有 phase、计数与累计用量 */
export type ProgressEvent = {
  chapter_id?: number
  status?: string
  error?: string
  units_done?: number
  units_total?: number
  done?: number
  total?: number
  phase?: string
  success_count?: number
  failure_count?: number
  running_count?: number
  queued_count?: number
  llm_requests?: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

/** SSE done：任务终态（status 为 analyzed / failed / cancelled / idle）；published 表示本次是否发布了新结果 */
export type DoneEvent = {
  task_id?: string
  status: string
  phase?: string
  stopped?: boolean
  published?: boolean
  revision_id?: string | null
  message?: string
  chapters_done: number
  chapters_failed: number
  chapters_done_ids?: number[]
  chapters_failed_ids?: number[]
  chapters_partial_ids?: number[]
  errors?: { chapter_id: number; error: string }[]
  total?: number
  llm_requests?: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) throw new Error(await readError(res))
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
  /** 章节聚焦；缺省 = 全书 */
  chapter?: number
  chapter_mode?: ChapterMode
  min_appearance?: number
  predicate_filter?: string
  category_filter?: string
}

export function getGraph(bookId: string, q: GraphQuery = {}): Promise<GraphData> {
  const params = new URLSearchParams()
  if (q.chapter != null) {
    params.set('chapter', String(q.chapter))
    params.set('chapter_mode', q.chapter_mode ?? 'upto')
  }
  if (q.min_appearance != null) params.set('min_appearance', String(q.min_appearance))
  if (q.category_filter) params.set('category_filter', q.category_filter)
  if (q.predicate_filter) params.set('predicate_filter', q.predicate_filter)
  const qs = params.toString()
  return request<GraphData>(`/api/books/${bookId}/graph${qs ? `?${qs}` : ''}`)
}

/**
 * 启动整书分析。默认沿用仍有效的章节结果（对失败的分析再次启动即「只补读失败章」）；
 * force=true 时忽略已存结果、全部重读。
 */
export function startAnalysis(
  bookId: string,
  toChapter?: number,
  force = false,
): Promise<AnalyzeStartResult> {
  const params = new URLSearchParams()
  if (toChapter != null) params.set('to_chapter', String(toChapter))
  if (force) params.set('force', 'true')
  const qs = params.toString()
  return request<AnalyzeStartResult>(`/api/books/${bookId}/analyze${qs ? `?${qs}` : ''}`, {
    method: 'POST',
  })
}

export function getAnalysisTask(bookId: string): Promise<AnalysisTaskSnapshot> {
  return request<AnalysisTaskSnapshot>(`/api/books/${bookId}/analysis/task`)
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
 * 订阅分析进度 SSE，返回关闭函数。服务端先回放本任务的历史事件再转实时；
 * 断线时 EventSource 自动重连并带 Last-Event-ID，只补发更新的事件；收到 done 后自动关闭。
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

  let warned = false
  es.onerror = () => {
    if (closed) return
    if (es.readyState === EventSource.CLOSED) {
      // 服务端拒绝（如 404）时浏览器不再重连
      close()
      handlers.onError?.('进度连接已断开，刷新页面可恢复')
      return
    }
    // 其余情况浏览器会自动重连，只提示一次
    if (!warned) handlers.onError?.('进度连接中断，正在重连…')
    warned = true
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
}

/** 人名册只读（PRD §5.8：本期不做人工合并 / 改名） */
export type Cast = {
  persons: CastPerson[]
}

type CastResponse = {
  persons: {
    person_id: string
    canonical_name: string
    aliases: string[]
    bio: string | null
    gender: string
    importance: string | null
  }[]
}

export async function getCast(bookId: string): Promise<Cast> {
  const data = await request<CastResponse>(`/api/books/${bookId}/cast`)
  return {
    persons: (data.persons ?? []).map((p) => ({
      person_id: p.person_id,
      canonical_name: p.canonical_name,
      aliases: p.aliases.map((name) => ({ name, frequency: '' })),
      bio: p.bio ?? '',
      gender: p.gender,
      importance: p.importance ?? '',
    })),
  }
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
  /** 本章内的称呼（新人物尚无全书 ID 时用于显示） */
  name?: string
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

type ExtractionEvidence = { note: string; quotes: { text: string }[] }

type ProposedType = {
  name: string
  definition: string
  hardness: string
  directed: boolean
  source_role: string | null
  target_role: string | null
}

type ExtractionResponse = {
  chapter_id: number
  analysis_status: 'complete' | 'partial'
  warnings: string[]
  summary: string
  persons: { local_id: string; existing_person_id: string | null; names: { name: string }[] }[]
  relations: {
    id: string
    source: string
    target: string
    type: { type_id?: string; new_type?: ProposedType }
    description: string
    evidence: ExtractionEvidence[]
    verdict: 'supported' | 'undetermined' | 'refuted'
    assessment_basis: string
  }[]
  interactions: { participants: string[]; description: string }[]
}

const HARDNESS_LABEL: Record<string, string> = { hard: '硬关系', medium: '中关系', soft: '软关系' }

/** 单章抽取结果，转换成账本面板的结构；人物 ID 用已绑定的全书 ID，新人物用章内编号。 */
export async function getChapterLedger(bookId: string, chapterId: number): Promise<ChapterLedger> {
  const [x, types] = await Promise.all([
    request<ExtractionResponse>(`/api/books/${bookId}/chapters/${chapterId}/result`),
    getRelationTypes(bookId).catch(() => [] as RelationTypeMeta[]),
  ])
  const typeById = new Map(types.map((t) => [t.predicate, t]))
  const idOf = new Map(x.persons.map((p) => [p.local_id, p.existing_person_id ?? p.local_id]))
  const pid = (local: string) => idOf.get(local) ?? local
  return {
    analysis_status: x.analysis_status,
    warnings: x.warnings,
    chapter_id: x.chapter_id,
    summary: x.summary,
    persons: x.persons.map((p) => ({
      person_id: pid(p.local_id),
      name: p.names[0]?.name ?? p.local_id,
      aliases_in_chapter: p.names.slice(1).map((n) => n.name),
    })),
    relations: x.relations.map((r) => {
      const known = r.type.type_id ? typeById.get(r.type.type_id) : undefined
      const proposed = r.type.new_type
      const ev = r.evidence[0]
      return {
        relation_id: r.id,
        raw_relation: r.description,
        predicate: r.type.type_id ?? null,
        normalization_status: known ? 'resolved' : 'pending',
        normalization_reason: proposed ? `新类型建议：${proposed.name}` : '',
        status: r.verdict === 'supported' ? 'confirmed' : r.verdict === 'refuted' ? 'rejected' : 'pending',
        verification_reason: r.assessment_basis,
        person_a: pid(r.source),
        person_b: pid(r.target),
        label: known?.label ?? proposed?.name ?? r.type.type_id ?? '',
        category: known?.category ?? HARDNESS_LABEL[proposed?.hardness ?? ''] ?? '',
        definition: known?.definition ?? proposed?.definition ?? '',
        directed: known?.directed ?? proposed?.directed ?? false,
        subject_role: known?.subject_role ?? proposed?.source_role ?? '',
        object_role: known?.object_role ?? proposed?.target_role ?? '',
        evidence: {
          chapter_id: x.chapter_id,
          quote: ev?.quotes.map((q) => q.text).join('……') ?? '',
          note: ev?.note ?? '',
          quote_verified: ev && ev.quotes.length ? true : null,
        },
      }
    }),
    events: x.interactions.map((i) => ({ description: i.description, persons: i.participants.map(pid) })),
  }
}

/** 单章重跑（异步，返回 202 与任务 ID）；进度与终态走同一条 SSE，由 useAnalysis 订阅。 */
export function startRerun(bookId: string, chapterId: number): Promise<AnalyzeStartResult> {
  return request<AnalyzeStartResult>(`/api/books/${bookId}/chapters/${chapterId}/rerun`, { method: 'POST' })
}

// ── Export ──

async function readError(res: Response): Promise<string> {
  let detail = res.statusText
  try {
    const body = await res.json()
    detail = body.message || body.detail || body.title || JSON.stringify(body)
  } catch {
    /* ignore */
  }
  return `${res.status}: ${detail}`
}

/**
 * GET /export → JSON bundle (meta / cast / factions / overrides / graph / ledgers).
 * Triggers a browser download using Content-Disposition when present.
 */
export async function downloadExport(bookId: string, focus?: ChapterFocusParam | null): Promise<string> {
  const qs = focus ? `?chapter=${focus.chapter}&chapter_mode=${focus.mode}` : ''
  const res = await fetch(`/api/books/${bookId}/export${qs}`)
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

const HARDNESS_PRIORITY: Record<string, number> = { hard: 0, medium: 1, soft: 2 }

export async function getRelationTypes(bookId: string): Promise<RelationTypeMeta[]> {
  const data = await request<{ relation_types: (RelationTypeMeta & { hardness?: string })[] }>(
    `/api/books/${bookId}/relation-types`,
  )
  return data.relation_types.map((t) => ({
    ...t,
    display_priority: t.display_priority ?? HARDNESS_PRIORITY[t.hardness ?? ''] ?? 3,
  }))
}
