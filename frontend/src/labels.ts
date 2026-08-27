/** 中文标签：状态 / 重要度 / 性别。UI 专用，不进 API 类型。 */

export const BOOK_STATUS_LABEL: Record<string, string> = {
  uploaded: '已上传',
  cast_pass: '人名扫描',
  analyzing: '分析中',
  reconciling: '校对中',
  analyzed: '已分析',
  reconcile_failed: '校对失败',
  failed: '失败',
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

export const TIER_LABEL: Record<string, string> = {
  hard: '硬关系',
  mid: '中关系',
  soft: '软关系',
}

export function statusLabel(status: string | undefined): string {
  if (!status) return ''
  return BOOK_STATUS_LABEL[status] ?? status
}
