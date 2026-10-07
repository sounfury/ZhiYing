/**
 * 应用外壳：顶栏 + 主体两栏（图谱区 + 侧栏，≤900px 侧栏落到图下方），外加书架抽屉与提示条。
 * 只负责把全局状态接到各区域组件上，并处理页面级快捷键（Esc 退出中心视图 / 取消选中）。
 */
import { useCallback, useEffect, useState } from 'react'
import { GraphView, type ZoomRequest } from './components/GraphView'
import { HeaderBar } from './components/HeaderBar'
import { GraphToolbar } from './components/GraphToolbar'
import { AnalysisProgress } from './components/AnalysisProgress'
import { DetailPanel } from './components/DetailPanel'
import { CastPanel } from './components/CastPanel'
import { LedgerPanel } from './components/LedgerPanel'
import { SidePanel } from './components/SidePanel'
import { EmptyState } from './components/EmptyState'
import { BookShelf } from './components/BookShelf'
import { AppStateProvider } from './state/AppStateProvider'
import { ALL_BOOK_FOCUS } from './types'
import { useAppState } from './state/useAppState'
import './App.css'
import './styles/graph.css'
import './styles/progress.css'
import './panels.css'

export default function App() {
  return (
    <AppStateProvider>
      <AppLayout />
    </AppStateProvider>
  )
}

/** 普通提示几秒后自动消失；错误一直留着，等用户关掉 */
const MSG_TTL_MS = 6000

function AppLayout() {
  const s = useAppState()
  const hasBook = Boolean(s.bookId)
  const [shelfOpen, setShelfOpen] = useState(false)
  const closeShelf = useCallback(() => setShelfOpen(false), [])
  // 图工具条的放大 / 缩小请求（GraphToolbar → GraphView）
  const [zoomRequest, setZoomRequest] = useState<ZoomRequest | null>(null)
  const requestZoom = useCallback((kind: ZoomRequest['kind']) => setZoomRequest({ kind, nonce: Date.now() }), [])

  const { msg, error, clearBanner } = s
  useEffect(() => {
    if (!msg || error) return
    const t = window.setTimeout(clearBanner, MSG_TTL_MS)
    return () => window.clearTimeout(t)
  }, [msg, error, clearBanner])

  // Esc：先退出中心视图，再取消选中（输入框里的 Esc 留给输入框自己）
  const { egoPersonId, setEgoPersonId, setSelectedNode, setSelectedEdge } = s
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || shelfOpen) return
      const el = e.target as HTMLElement | null
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return
      if (egoPersonId) {
        setEgoPersonId(null)
      } else {
        setSelectedNode(null)
        setSelectedEdge(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [shelfOpen, egoPersonId, setEgoPersonId, setSelectedNode, setSelectedEdge])

  return (
    <div className="app">
      <HeaderBar
        selectedBook={s.selectedBook}
        contentChapters={s.contentChapters}
        isRunning={s.isRunning}
        graph={s.graph}
        exporting={s.exporting}
        toChapter={s.toChapter}
        onToChapterChange={s.setToChapter}
        onOpenShelf={() => setShelfOpen(true)}
        onPickPerson={s.onPickPerson}
        onAnalyze={s.onAnalyze}
        onStop={s.onStop}
        onExport={s.onExport}
      />

      <main className={`main${hasBook ? '' : ' solo'}`}>
        <section className="stage" aria-label="人物关系图">
          {!hasBook ? (
            <EmptyState books={s.books} onSelectBook={s.handleBookChange} onUpload={s.onUpload} />
          ) : s.graph && s.graph.nodes.length > 0 ? (
            <GraphView
              data={s.graph}
              layoutMode={s.layoutMode}
              selectedFactions={s.selectedFactions}
              focusRequest={s.focusRequest}
              zoomRequest={zoomRequest}
              selectedPersonId={s.selectedNode?.person_id ?? null}
              selectedEdge={s.selectedEdge}
              egoPersonId={s.egoPersonId}
              refitToken={s.refitToken}
              scopeLabel={s.scopeLabel}
              onExitEgo={() => s.setEgoPersonId(null)}
              onEnterEgo={s.setEgoPersonId}
              onSelectEdge={(e) => {
                s.setSelectedEdge(e)
                if (e) s.openSide('detail')
              }}
              onSelectNode={(n) => {
                s.setSelectedNode(n)
                if (n) s.openSide('detail')
              }}
            />
          ) : (
            <div className="graph-empty">
              {s.isRunning ? (
                <>
                  分析进行中，完成后会自动出图…
                  <br />
                  <span className="hint">{s.analysis.phase}</span>
                </>
              ) : s.graphLoading ? (
                '正在铺开人物图…'
              ) : s.graph ? (
                <>
                  这个范围里还没有人物入图。
                  <br />
                  <span className="hint">换个章节范围，或放宽筛选条件。</span>
                </>
              ) : (
                <>
                  尚未成图。
                  <br />
                  <span className="hint">点右上角「开始分析」，把人物织进关系图。</span>
                </>
              )}
            </div>
          )}

          {hasBook && (
            <GraphToolbar
              contentChapters={s.contentChapters}
              chapterFocus={s.chapterFocus}
              onChapterFocusChange={s.setChapterFocus}
              layoutMode={s.layoutMode}
              onLayoutModeChange={s.setLayoutMode}
              factions={s.graph?.factions ?? []}
              selectedFactions={s.selectedFactions}
              onSelectedFactionsChange={s.setSelectedFactions}
              minAppearance={s.minAppearance}
              onMinAppearanceChange={s.setMinAppearance}
              categoryFilter={s.categoryFilter}
              onCategoryFilterChange={s.setCategoryFilter}
              typeFilter={s.typeFilter}
              onTypeFilterChange={s.setTypeFilter}
              relationTypes={s.relationTypes}
              filteredCount={s.graph?.filtered_count ?? 0}
              onRefit={s.requestRefit}
              isRunning={s.isRunning}
              onZoom={requestZoom}
              hasGraph={!!s.graph?.nodes.length}
              chapterPeopleCount={s.graph?.chapter_focus?.mode === 'single' ? s.graph.nodes.length : undefined}
            />
          )}

          {hasBook && (
            <AnalysisProgress
              analysis={s.analysis}
              bookTitle={s.selectedBook?.title ?? ''}
              chapters={s.contentChapters}
              hasPrevious={Boolean(s.graph)}
              onStop={() => void s.onStop()}
              onRetryFailed={() => void s.onRetryFailed()}
              onDismiss={s.onDismissAnalysis}
            />
          )}
        </section>

        {hasBook && (
          <SidePanel
            tab={s.sideTab}
            onTab={s.openSide}
            castCount={s.graph?.nodes.length}
            focus={s.graph?.chapter_focus}
            chapters={s.contentChapters}
            onShowAll={() => s.setChapterFocus(ALL_BOOK_FOCUS)}
            detail={
              <DetailPanel
                graph={s.graph}
                book={s.selectedBook}
                castCount={s.cast?.persons.length}
                chapters={s.contentChapters}
                chapterLabel={s.chapterLabel}
                selectedNode={s.selectedNode}
                selectedEdge={s.selectedEdge}
                egoPersonId={s.egoPersonId}
                focusLedger={s.focusLedger}
                focusLedgerLoading={s.focusLedgerLoading}
                onSetEgo={s.setEgoPersonId}
                onFocusPerson={s.onFocusCastPerson}
                onJumpChapter={(chapter) => s.setChapterFocus({ mode: 'single', chapter })}
                onSelectEdge={(edge) => {
                  s.setSelectedNode(null)
                  s.setSelectedEdge(edge)
                }}
              />
            }
            cast={
              <CastPanel
                graph={s.graph}
                chapters={s.contentChapters}
                loading={s.graphLoading}
                onFocusPerson={s.onFocusCastPerson}
              />
            }
            ledger={
              <LedgerPanel
                chapters={s.contentChapters}
                progress={s.selectedBook?.analysis_progress}
                focus={s.chapterFocus}
                entries={s.chapterLedgers}
                onRequest={s.requestChapterLedger}
                rerunningChapterId={s.rerunningChapterId}
                disabled={s.isRunning}
                nameOf={s.personName}
                onFocusChapter={(chapter) => s.setChapterFocus({ mode: 'single', chapter })}
                onRerun={(chapterId) => void s.onRerunChapter(chapterId)}
                onFocusPerson={s.onFocusCastPerson}
              />
            }
          />
        )}
      </main>

      <BookShelf
        open={shelfOpen}
        books={s.books}
        bookId={s.bookId}
        onClose={closeShelf}
        onSelect={s.handleBookChange}
        onUpload={s.onUpload}
      />

      {(error || msg) && (
        <div className={`toast ${error ? 'err' : 'ok'}`} role={error ? 'alert' : 'status'}>
          <span>{error || msg}</span>
          <button type="button" className="btn ghost" onClick={clearBanner} aria-label="关闭提示">
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
