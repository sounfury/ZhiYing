import type { FormEvent } from 'react'

interface HeaderBarProps {
  /** 选中了书才允许分析 / 刷新 */
  bookId: string
  isRunning: boolean
  graphLoading: boolean
  onUpload: (file: File | null) => void
  onAnalyze: () => void
  onStop: () => void
  onRefreshGraph: () => void
}

export function HeaderBar({
  bookId,
  isRunning,
  graphLoading,
  onUpload,
  onAnalyze,
  onStop,
  onRefreshGraph,
}: HeaderBarProps) {
  return (
    <header className="top">
      <div className="brand">
        <h1>ZhiYing</h1>
        <span className="sub">最小预览 · 人物关系图</span>
      </div>
      <div className="actions">
        <label className="btn file-btn">
          上传 EPUB
          <input
            type="file"
            accept=".epub"
            hidden
            onChange={(e: FormEvent<HTMLInputElement>) =>
              void onUpload(e.currentTarget.files?.[0] ?? null)
            }
          />
        </label>
        <button
          type="button"
          className="btn"
          disabled={!bookId || isRunning}
          onClick={() => void onAnalyze()}
        >
          {isRunning ? '分析中…' : '启动分析'}
        </button>
        {isRunning && (
          <button type="button" className="btn danger" onClick={() => void onStop()}>
            停止
          </button>
        )}
        <button
          type="button"
          className="btn primary"
          disabled={!bookId || graphLoading || isRunning}
          onClick={() => void onRefreshGraph()}
        >
          {graphLoading ? '加载中…' : '刷新图'}
        </button>
      </div>
    </header>
  )
}