import type { FormEvent } from 'react'
import type { GraphData } from '../api'
import { PersonSearch, type PersonHit } from './PersonSearch'

interface HeaderBarProps {
  /** 选中了书才允许分析 / 刷新 */
  bookId: string
  isRunning: boolean
  graphLoading: boolean
  factionLoading: boolean
  graph: GraphData | null
  onPickPerson: (hit: PersonHit) => void
  onUpload: (file: File | null) => void
  onAnalyze: () => void
  onStop: () => void
  onRefreshGraph: () => void
  onExtractFactions: () => void
}

export function HeaderBar({
  bookId,
  isRunning,
  graphLoading,
  factionLoading,
  graph,
  onPickPerson,
  onUpload,
  onAnalyze,
  onStop,
  onRefreshGraph,
  onExtractFactions,
}: HeaderBarProps) {
  return (
    <header className="top">
      <div className="brand">
        <h1>ZhiYing</h1>
        <span className="sub">最小预览 · 人物关系图</span>
      </div>
      {!isRunning && <PersonSearch graph={graph} onPick={onPickPerson} />}
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
          className="btn"
          disabled={!bookId || isRunning || factionLoading}
          onClick={() => void onExtractFactions()}
          title="用 LLM 把人物划成学校 / 教会 / 家族等团体块，供势力分区布局使用"
        >
          {factionLoading ? '归纳势力中…' : '抽取势力'}
        </button>
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