/** 全局应用状态的类型契约与 React Context；实现见 AppStateProvider。 */
import { createContext } from 'react'
import type {
  BookMeta,
  Cast,
  ChapterBrief,
  ChapterLedger,
  GraphData,
  GraphEdge,
  GraphNode,
  RelationTypeMeta,
} from '../api'
import type { FocusRequest, LayoutMode, PngExportInfo } from '../components/GraphView'
import type { LedgerEntry } from '../hooks/useLedger'
import type { PersonHit } from '../components/PersonSearch'
import type { AnalysisUi, ChapterFocusState, SideTab } from '../types'

export type AppStateValue = {
  books: BookMeta[]
  publicOnly: boolean
  onShare: () => Promise<void>
  bookId: string
  selectedBook: BookMeta | undefined
  handleBookChange: (bookId: string) => void

  contentChapters: ChapterBrief[]
  chapterLabel: (id: number | undefined) => string
  toChapter: number | ''
  setToChapter: (v: number | '') => void
  chapterFocus: ChapterFocusState
  setChapterFocus: (v: ChapterFocusState) => void
  scopeLabel: string
  focusLedger: ChapterLedger | null
  focusLedgerLoading: boolean
  minAppearance: number
  setMinAppearance: (v: number) => void
  categoryFilter: string[]
  setCategoryFilter: (categories: string[]) => void
  typeFilter: string[]
  setTypeFilter: (types: string[]) => void
  relationTypes: RelationTypeMeta[]

  graph: GraphData | null
  graphLoading: boolean

  layoutMode: LayoutMode
  setLayoutMode: (v: LayoutMode) => void
  selectedFactions: string[]
  setSelectedFactions: (ids: string[]) => void

  selectedEdge: GraphEdge | null
  setSelectedEdge: (e: GraphEdge | null) => void
  selectedNode: GraphNode | null
  setSelectedNode: (n: GraphNode | null) => void
  egoPersonId: string | null
  setEgoPersonId: (id: string | null) => void
  focusRequest: FocusRequest | null

  sideTab: SideTab
  /** 切侧栏页签 */
  openSide: (tab: SideTab) => void
  /** 图重新适应窗口的计数器（传给 GraphView.refitToken）；requestRefit 递增它 */
  refitToken: number
  requestRefit: () => void

  error: string
  msg: string
  clearBanner: () => void

  analysis: AnalysisUi
  isRunning: boolean

  onUpload: (file: File | null) => Promise<void>
  /** 删除书（调用方已确认）；删的是当前书则回到空态 */
  onDeleteBook: (bookId: string) => Promise<void>
  /** 清空书的分析结果（调用方已确认）；给了 [rule] 则改选 TXT 分章方案（同样清空分析并重切章）；是当前书则图、人名册、章节一并刷新 */
  onClearAnalysis: (bookId: string, rule?: string) => Promise<void>
  /** 启动整书分析；force=true 全部重读，否则复用仍有效的章节结果（即只补读失败 / 未读章） */
  onAnalyze: (opts?: { force?: boolean }) => Promise<void>
  onStop: () => Promise<void>
  /** 分析失败后的补救：整书分析只补读失败章（不 force）；单章重跑则再重跑那一章 */
  onRetryFailed: () => Promise<void>
  /** 收起分析结束提示 / 失败卡 */
  onDismissAnalysis: () => void
  onPickPerson: (hit: PersonHit) => void
  onExport: () => Promise<void>
  exporting: boolean
  /** 导出当前视图的 PNG（PRD-beta §5）：render 由图谱组件提供（重画并下载），这里补书名与筛选说明、报告结果 */
  onExportPng: (render: (opts: { bookTitle: string; notes: string[] }) => Promise<PngExportInfo>) => Promise<void>
  exportingPng: boolean

  cast: Cast | null
  castLoading: boolean
  /** 在图上聚焦某人并切到人物页签 */
  onFocusCastPerson: (personId: string) => void

  /** 章节页签：各章分析结果的按需缓存（按 chapter_id） */
  chapterLedgers: Record<number, LedgerEntry>
  requestChapterLedger: (chapterId: number) => void
  /** 正在单章重跑的章节；null = 没有 */
  rerunningChapterId: number | null
  onRerunChapter: (chapterId: number) => Promise<void>
  personName: (personId: string) => string
}

export const AppStateContext = createContext<AppStateValue | null>(null)
