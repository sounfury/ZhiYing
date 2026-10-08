/** 评测页的格式化小工具：百分比、token、耗时、时间、判断结论。 */

export const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)

export const formatTokens = (n: number) => (n >= 10_000 ? `${(n / 10_000).toFixed(1)} 万` : String(n))

export const formatDuration = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`)

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

const UNDETERMINED: Record<string, string> = {
  UNCLEAR_REFERENCE: '指代不明',
  AMBIGUOUS_TYPE_OR_DIRECTION: '类型或方向含糊',
  INSUFFICIENT_CONTEXT: '片段不足',
  FIGURATIVE_OR_HEARSAY: '比喻或传闻',
}

/** SUPPORTED / REFUTED / UNDETERMINED:<原因> → 中文 */
export function verdictLabel(code: string): string {
  if (code === 'SUPPORTED') return '成立'
  if (code === 'REFUTED') return '被否定'
  const reason = code.split(':')[1]
  return `未决${reason ? `（${UNDETERMINED[reason] ?? reason}）` : ''}`
}
