import { GraphView } from './components/GraphView'
import { HeaderBar } from './components/HeaderBar'
import { ControlPanel } from './components/ControlPanel'
import { AnalysisProgress } from './components/AnalysisProgress'
import { DetailPanel } from './components/DetailPanel'
import { AppStateProvider } from './state/AppStateProvider'
import { useAppState } from './state/useAppState'
import './App.css'

export default function App() {
  return (
    <AppStateProvider>
      <AppLayout />
    </AppStateProvider>
  )
}

function AppLayout() {
  const s = useAppState()

  return (
    <div className="app">
      <HeaderBar
        bookId={s.bookId}
        isRunning={s.isRunning}
        graphLoading={s.graphLoading}
        factionLoading={s.factionLoading}
        graph={s.graph}
        onPickPerson={s.onPickPerson}
        onUpload={s.onUpload}
        onAnalyze={s.onAnalyze}
        onStop={s.onStop}
        onRefreshGraph={() => void s.handleLoadGraph()}
        onExtractFactions={() => void s.onExtractFactions()}
      />

      <ControlPanel
        books={s.books}
        bookId={s.bookId}
        selectedBook={s.selectedBook}
        onBookChange={s.handleBookChange}
        contentChapters={s.contentChapters}
        toChapter={s.toChapter}
        singleChapterOnly={s.singleChapterOnly}
        onToChapterChange={s.setToChapter}
        onSingleChapterOnlyChange={s.setSingleChapterOnly}
        minAppearance={s.minAppearance}
        onMinAppearanceChange={s.setMinAppearance}
        includeSuppressed={s.includeSuppressed}
        onIncludeSuppressedChange={s.setIncludeSuppressed}
        layoutMode={s.layoutMode}
        onLayoutModeChange={s.setLayoutMode}
        factions={s.graph?.factions ?? []}
        selectedFactions={s.selectedFactions}
        onSelectedFactionsChange={s.setSelectedFactions}
        isRunning={s.isRunning}
      />

      <AnalysisProgress analysis={s.analysis} />

      {(s.error || s.msg) && (
        <div className={`banner ${s.error ? 'err' : 'ok'}`}>
          {s.error || s.msg}
        </div>
      )}

      <main className={`main${s.sideCollapsed ? ' side-collapsed' : ''}`}>
        <div className="canvas-wrap">
          <button
            type="button"
            className="side-toggle"
            onClick={s.toggleSide}
            title={s.sideCollapsed ? '展开详情栏' : '收起详情栏'}
            aria-expanded={!s.sideCollapsed}
            aria-controls="detail-side"
          >
            {s.sideCollapsed ? '◀' : '▶'}
          </button>
          {s.isRunning ? (
            <div className="graph-empty">
              分析进行中，完成后会自动刷新图…
              <br />
              <span className="hint">当前阶段：{s.analysis.phase}</span>
            </div>
          ) : s.graph ? (
            <GraphView
              data={s.graph}
              layoutMode={s.layoutMode}
              selectedFactions={s.selectedFactions}
              focusRequest={s.focusRequest}
              selectedPersonId={s.selectedNode?.person_id ?? null}
              egoPersonId={s.egoPersonId}
              refitToken={s.refitToken}
              onExitEgo={() => s.setEgoPersonId(null)}
              onSelectEdge={s.setSelectedEdge}
              onSelectNode={s.setSelectedNode}
            />
          ) : (
            <div className="graph-empty">选择书籍并刷新图</div>
          )}
        </div>
        <DetailPanel
          graph={s.graph}
          selectedNode={s.selectedNode}
          selectedEdge={s.selectedEdge}
          egoPersonId={s.egoPersonId}
          chapterLabel={s.chapterLabel}
          onSetEgo={s.setEgoPersonId}
        />
      </main>
    </div>
  )
}
