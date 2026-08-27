/** UI 专用共享类型；API 类型继续放 api.ts */

export type LogLine = {
  id: number
  kind: 'info' | 'ok' | 'fail' | 'phase'
  text: string
}

export type AnalysisUi = {
  running: boolean
  total: number
  done: number
  phase: string
  logs: LogLine[]
}

export type GraphFilters = {
  toChapter: number | ''
  singleChapterOnly: boolean
  minAppearance: number
  includeSuppressed: boolean
  /** 空数组 = 不过滤（全部类型） */
  typeFilter: string[]
}

export type SideTab = 'detail' | 'cast' | 'ledger'

export const emptyAnalysis = (): AnalysisUi => ({
  running: false,
  total: 0,
  done: 0,
  phase: '',
  logs: [],
})
