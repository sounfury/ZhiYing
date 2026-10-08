/** 评测接口客户端（DESIGN §7）：评测集、准备并发起整书分析、评分与运行记录；字段与后端 snake_case 报告一致。 */

export type EvalRunSummary = {
  id: string
  created_at: string
  model: string
  score: number
  task_kind: string | null
  total_tokens: number | null
  duration_seconds: number | null
}

export type EvalSuite = {
  name: string
  book: string | null
  chapter_count: number | null
  /** 书库里对应的书；未导入为 null */
  book_id: string | null
  last_run: EvalRunSummary | null
  /** 标注读取失败的原因 */
  error: string | null
}

export type Metric = {
  key: string
  label: string
  hit: number
  total: number
  weight: number
  /** 分母为 0 时为 null；加权指标（必有关系召回）为加权比例，与 hit / total 不同 */
  value: number | null
  /** 计数的补充说明 */
  note: string | null
}

export type PersonRef = { id: string; name: string; aliases: string[]; importance: string | null }

export type TypeCriteria = { type_ids: string[]; keywords: string[] }

export type GoldRelation = {
  person_a: string
  person_b: string
  label: string
  criteria: TypeCriteria
  source: string | null
  evidence: string[]
  note: string | null
}

export type GoldForbidden = {
  person_a: string
  person_b: string
  criteria: TypeCriteria
  reason: string
  evidence: string[]
}

export type MissReason = 'PERSON_MISSING' | 'NO_RECORD' | 'WITHHELD' | 'WRONG_TYPE'

export type RelationCheck = {
  gold: GoldRelation
  hit: boolean
  reason: MissReason | null
  detail: string | null
  records: string[]
  direction_correct: boolean | null
  quoted: boolean
  /** 分档：强 / 中 / 弱，权重不同（DESIGN §7.3）；旧运行记录没有此字段 */
  tier?: Tier
  /** 弱关系漏检，但两人本章已有强 / 中关系，不扣分 */
  excused: boolean
}

export type Tier = 'HARD' | 'MEDIUM' | 'SOFT'

/** 一档必有关系的统计；excused 为弱关系漏检但已有强 / 中关系、不扣分的条数 */
export type TierStat = { tier: Tier; weight: number; total: number; hit: number; excused: number }

export type ForbiddenCheck = { gold: GoldForbidden; violated: boolean; records: string[] }

export type RecordView = {
  id: string
  person_a: string
  person_b: string
  type_id: string
  type_name: string
  directed: boolean
  admitted: boolean
  /** SUPPORTED / REFUTED / UNDETERMINED:<原因> */
  verdict: string
  basis: string
  evidence: { note: string; quotes: string[] }[]
}

export type ChapterReport = {
  number: number
  title: string
  actual_title: string
  required: RelationCheck[]
  optional: RelationCheck[]
  forbidden: ForbiddenCheck[]
  unlabeled: string[]
  records: RecordView[]
}

export type EvalReport = {
  score: number
  metrics: Metric[]
  diagnostics: Metric[]
  people: { gold: string; matched: PersonRef[] }[]
  wrong_merges: { person: PersonRef; golds: string[] }[]
  persons: PersonRef[]
  chapters: ChapterReport[]
  gold_issues: string[]
  /** 必有关系按档统计；旧运行记录没有 */
  tiers?: TierStat[]
}

export type EvalRun = {
  id: string
  suite: string
  book_id: string
  revision_id: string
  created_at: string
  model: string
  task_kind: string | null
  usage: { requests: number; input_tokens: number; output_tokens: number; total_tokens: number } | null
  duration_seconds: number | null
  report: EvalReport
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.message || body.detail || detail
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

const base = (name: string) => `/api/eval/suites/${encodeURIComponent(name)}`

export async function listSuites(): Promise<EvalSuite[]> {
  return (await request<{ suites: EvalSuite[] }>('/api/eval/suites')).suites
}

/** 未导入则导入、已导入则清空分析，然后发起整书分析；进度走普通的分析进度推送。 */
export function prepareSuite(name: string): Promise<{ book_id: string; task_id: string; total_chapters: number; imported: boolean }> {
  return request(`${base(name)}/prepare`, { method: 'POST' })
}

/** 给当前已发布的结果评分，返回新的运行记录。 */
export function scoreSuite(name: string): Promise<EvalRun> {
  return request(`${base(name)}/runs`, { method: 'POST' })
}

export async function listRuns(name: string): Promise<EvalRunSummary[]> {
  return (await request<{ runs: EvalRunSummary[] }>(`${base(name)}/runs`)).runs
}

export function getRun(name: string, id: string): Promise<EvalRun> {
  return request(`${base(name)}/runs/${encodeURIComponent(id)}`)
}
