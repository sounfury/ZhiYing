/** UI 专用共享类型；API 类型继续放 api.ts */
import type { AnalysisTaskSnapshot } from './api'

export type LogLine = {
  id: number
  kind: 'info' | 'ok' | 'fail' | 'phase'
  text: string
}

/** 分析进度的前端状态：以后端任务快照为准，SSE 事件合并进 task */
export type AnalysisUi = {
  /** 本页正在跟踪一个运行中的任务（含刚点下启动、快照尚未返回时） */
  running: boolean
  /** 已请求停止，等待进行中的模型请求返回 */
  stopping: boolean
  /** 当前或最近一次任务快照；null = 没有可展示的任务 */
  task: AnalysisTaskSnapshot | null
  /** 结束提示已被收起 */
  dismissed: boolean
  /** 一句话阶段说明（图谱空态等处引用） */
  phase: string
  /** 详细日志（进度卡里默认收起） */
  logs: LogLine[]
  /** 仅开发模式：内置假快照（?mockProgress=），不自动淡出 */
  demo?: boolean
}

/** 章节聚焦状态：all = 全书；single = 第 N 章；upto = 前 N 章（chapter 为章节 id） */
export type ChapterFocusState = { mode: 'all' | 'single' | 'upto'; chapter: number }

export const ALL_BOOK_FOCUS: ChapterFocusState = { mode: 'all', chapter: 0 }

export type GraphFilters = {
  chapterFocus: ChapterFocusState
  minAppearance: number
  /** 空数组 = 不过滤（全部类型） */
  typeFilter: string[]
  categoryFilter: string[]
}

export type SideTab = 'detail' | 'cast' | 'ledger'

export const emptyAnalysis = (): AnalysisUi => ({
  running: false,
  stopping: false,
  task: null,
  dismissed: false,
  phase: '',
  logs: [],
})
