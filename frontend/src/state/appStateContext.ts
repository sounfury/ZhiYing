import { createContext } from 'react'
import type { BookMeta, ChapterBrief, GraphData, GraphEdge, GraphNode } from '../api'
import type { FocusRequest, LayoutMode } from '../components/GraphView'
import type { PersonHit } from '../components/PersonSearch'
import type { AnalysisUi } from '../types'

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
  refitToken: number
  toggleSide: () => void

  error: string
  msg: string

  analysis: AnalysisUi
  isRunning: boolean

  onUpload: (file: File | null) => Promise<void>
  onAnalyze: () => Promise<void>
  onStop: () => Promise<void>
  onExtractFactions: () => Promise<void>
  onPickPerson: (hit: PersonHit) => void
}

export const AppStateContext = createContext<AppStateValue | null>(null)
