import { GraphView } from './components/GraphView'
import { HeaderBar } from './components/HeaderBar'
import { ControlPanel } from './components/ControlPanel'
import { AnalysisProgress } from './components/AnalysisProgress'
import { DetailPanel } from './components/DetailPanel'
import { CastPanel } from './components/CastPanel'
import { LedgerPanel } from './components/LedgerPanel'
import { SidePanel } from './components/SidePanel'
import { EmptyState } from './components/EmptyState'
import { AppStateProvider } from './state/AppStateProvider'
import { useAppState } from './state/useAppState'
import './App.css'
import './panels.css'

export default function App() {
  return (
    <AppStateProvider>
      <AppLayout />
    </AppStateProvider>
  )
}

function AppLayout() {
  const s = useAppState()
  const hasBook = Boolean(s.bookId)

  return (
    <div className="app">
      <HeaderBar
        bookId={s.bookId}
        selectedBook={s.selectedBook}
        isRunning={s.isRunning}
        graph={s.graph}
        exporting={s.exporting}
        onPickPerson={s.onPickPerson}
        onUpload={s.onUpload}
        onAnalyze={s.onAnalyze}
        onStop={s.onStop}
        onExport={s.onExport}
      />

      {hasBook && (
        <ControlPanel
          books={s.books}
          bookId={s.bookId}
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
          typeFilter={s.typeFilter}
          onTypeFilterChange={s.setTypeFilter}
          relationTypes={s.relationTypes}
          layoutMode={s.layoutMode}
          onLayoutModeChange={s.setLayoutMode}
          factions={s.graph?.factions ?? []}
          selectedFactions={s.selectedFactions}
          onSelectedFactionsChange={s.setSelectedFactions}
          isRunning={s.isRunning}
          graphLoading={s.graphLoading}
          factionLoading={s.factionLoading}
          onRefreshGraph={() => void s.handleLoadGraph()}
          onExtractFactions={() => void s.onExtractFactions()}
          onOpenSide={s.openSide}
        />
      )}

      {hasBook && <AnalysisProgress analysis={s.analysis} />}

      {(s.error || s.msg) && (
        <div className={`banner ${s.error ? 'err' : 'ok'}`}>{s.error || s.msg}</div>
      )}

      <main
        className={`main${s.sideCollapsed ? ' side-collapsed' : ''}${hasBook ? '' : ' solo'}`}
      >
        <div className="canvas-wrap">
          {hasBook && (
            <button
              type="button"
              className="side-toggle"
              onClick={s.toggleSide}
              title={s.sideCollapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!s.sideCollapsed}
              aria-controls="detail-side"
            >
              {s.sideCollapsed ? '◀' : '▶'}
            </button>
          )}
          {!hasBook ? (
            <EmptyState
              books={s.books}
              onSelectBook={s.handleBookChange}
              onUpload={s.onUpload}
            />
          ) : s.isRunning ? (
            <div className="graph-empty">
              分析进行中，完成后会自动刷新图…
              <br />
              <span className="hint">当前阶段：{s.analysis.phase}</span>
            </div>
          ) : s.graphLoading && !s.graph ? (
            <div className="graph-empty">正在铺开人物图…</div>
          ) : s.graph ? (
            s.graph.nodes.length === 0 ? (
              <div className="graph-empty">
                这一段还没有人物入图。
                <br />
                <span className="hint">也许尚未分析，或筛选过严。</span>
              </div>
            ) : (
              <GraphView
                data={s.graph}
                layoutMode={s.layoutMode}
                selectedFactions={s.selectedFactions}
                focusRequest={s.focusRequest}
                selectedPersonId={s.selectedNode?.person_id ?? null}
                egoPersonId={s.egoPersonId}
                refitToken={s.refitToken}
                onExitEgo={() => s.setEgoPersonId(null)}
                onSelectEdge={(e) => {
                  s.setSelectedEdge(e)
                  if (e) s.openSide('detail')
                }}
                onSelectNode={(n) => {
                  s.setSelectedNode(n)
                  if (n) s.openSide('detail')
                }}
              />
            )
          ) : (
            <div className="graph-empty">
              尚未成图。
              <br />
              <span className="hint">点上方「启动分析」，把人物织进关系图。</span>
            </div>
          )}
        </div>
        {hasBook && (
          <SidePanel
            tab={s.sideTab}
            onTab={s.openSide}
            castCount={s.cast?.persons.length}
            detail={
              <DetailPanel
                graph={s.graph}
                selectedNode={s.selectedNode}
                selectedEdge={s.selectedEdge}
                egoPersonId={s.egoPersonId}
                chapterLabel={s.chapterLabel}
                onSetEgo={s.setEgoPersonId}
              />
            }
            cast={
              <CastPanel
                cast={s.cast}
                loading={s.castLoading}
                saving={s.castSaving}
                error={s.castError}
                graph={s.graph}
                disabled={s.isRunning}
                onSavePerson={s.saveCastPerson}
                onMerge={s.mergeCast}
                onFocusPerson={s.onFocusCastPerson}
              />
            }
            ledger={
              <LedgerPanel
                chapters={s.contentChapters}
                chapterId={s.ledgerChapterId}
                onChapterChange={s.setLedgerChapterId}
                ledger={s.ledger}
                loading={s.ledgerLoading}
                missing={s.ledgerMissing}
                error={s.ledgerError}
                rerunning={s.rerunning}
                disabled={s.isRunning}
                nameOf={s.personName}
                onRerun={() => void s.onRerunChapter()}
                onFocusPerson={s.onFocusCastPerson}
              />
            }
          />
        )}
      </main>
    </div>
  )
}
