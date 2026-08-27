import { createContext } from 'react'
import type {
  BookMeta,
  Cast,
  CastPerson,
  ChapterBrief,
  ChapterLedger,
  GraphData,
  GraphEdge,
  GraphNode,
  RelationTypeMeta,
} from '../api'
import type { FocusRequest, LayoutMode } from '../components/GraphView'
import type { PersonHit } from '../components/PersonSearch'
import type { AnalysisUi, SideTab } from '../types'

export type AppStateValue = {
  books: BookMeta[]
  bookId: string
  selectedBook: BookMeta | undefined
  handleBookChange: (bookId: string) => void

  contentChapters: ChapterBrief[]
  chapterLabel: (id: number | undefined) => string
  toChapter: number | ''
  setToChapter: (v: number | '') => void
  singleChapterOnly: boolean
  setSingleChapterOnly: (v: boolean) => void
  minAppearance: number
  setMinAppearance: (v: number) => void
  includeSuppressed: boolean
  setIncludeSuppressed: (v: boolean) => void
  typeFilter: string[]
  setTypeFilter: (types: string[]) => void
  relationTypes: RelationTypeMeta[]

  graph: GraphData | null
  graphLoading: boolean
  handleLoadGraph: () => Promise<void>

  layoutMode: LayoutMode
  setLayoutMode: (v: LayoutMode) => void
  selectedFactions: string[]
  setSelectedFactions: (ids: string[]) => void
  factionLoading: boolean

  selectedEdge: GraphEdge | null
  setSelectedEdge: (e: GraphEdge | null) => void
  selectedNode: GraphNode | null
  setSelectedNode: (n: GraphNode | null) => void
  egoPersonId: string | null
  setEgoPersonId: (id: string | null) => void
  focusRequest: FocusRequest | null

  sideCollapsed: boolean
  sideTab: SideTab
  setSideTab: (tab: SideTab) => void
  refitToken: number
  toggleSide: () => void
  openSide: (tab: SideTab) => void

  error: string
  msg: string

  analysis: AnalysisUi
  isRunning: boolean

  onUpload: (file: File | null) => Promise<void>
  onAnalyze: () => Promise<void>
  onStop: () => Promise<void>
  onExtractFactions: () => Promise<void>
  onPickPerson: (hit: PersonHit) => void
  onExport: () => Promise<void>
  exporting: boolean

  cast: Cast | null
  castLoading: boolean
  castSaving: boolean
  castError: string
  saveCastPerson: (person: CastPerson) => Promise<void>
  mergeCast: (keepId: string, dropId: string) => Promise<void>
  onFocusCastPerson: (personId: string) => void

  ledgerChapterId: number | ''
  setLedgerChapterId: (id: number | '') => void
  ledger: ChapterLedger | null
  ledgerLoading: boolean
  ledgerMissing: boolean
  ledgerError: string
  rerunning: boolean
  onRerunChapter: () => Promise<void>
  personName: (personId: string) => string
}

export const AppStateContext = createContext<AppStateValue | null>(null)
