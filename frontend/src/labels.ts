/** 中文标签：状态 / 重要度 / 性别。UI 专用，不进 API 类型。 */

export const BOOK_STATUS_LABEL: Record<string, string> = {
  uploaded: '已上传',
  cast_pass: '人名扫描',
  analyzing: '分析中',
  reconciling: '校对中',
  analyzed: '已分析',
  partial: '部分完成',
  reconcile_failed: '校对失败',
  failed: '失败',
  cancelled: '已取消',
}

/** token 数的简短显示：12.3 万 / 1.2 亿。 */
export function formatTokens(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`
  return String(n)
}

export const IMPORTANCE_LABEL: Record<string, string> = {
  main: '主角',
  supporting: '配角',
  minor: '龙套',
}

export const GENDER_LABEL: Record<string, string> = {
  male: '男',
  female: '女',
  unknown: '未知',
}

export function statusLabel(status: string | undefined): string {
  if (!status) return ''
  return BOOK_STATUS_LABEL[status] ?? status
}

/** 字数的简短显示：16.1 万字 / 8000 字。 */
export function formatWords(n: number): string {
  return n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万字` : `${n} 字`
}

/** 书名去掉营销性的括号副标题，如「一个青年艺术家的画像（兰登书屋…）(果麦经典)」→「一个青年艺术家的画像」。 */
export function shortTitle(title: string): string {
  const t = title.replace(/\s*[（(【[].*$/, '').trim()
  return t || title
}

/** 书的状态 pill 是否用警示色（未完成 / 失败 / 取消等） */
export function statusIsWarn(status: string | undefined): boolean {
  return status !== 'analyzed' && status !== 'analyzing' && status !== 'reconciling'
}
