import type { FormEvent } from 'react'
import type { BookMeta, GraphData } from '../api'
import { statusLabel } from '../labels'
import { PersonSearch, type PersonHit } from './PersonSearch'

interface HeaderBarProps {
  bookId: string
  selectedBook?: BookMeta
  isRunning: boolean
  graph: GraphData | null
  exporting: boolean
  onPickPerson: (hit: PersonHit) => void
  onUpload: (file: File | null) => void
  onAnalyze: () => void
  onStop: () => void
  onExport: () => void
}

export function HeaderBar({
  bookId,
  selectedBook,
  isRunning,
  graph,
  exporting,
  onPickPerson,
  onUpload,
  onAnalyze,
  onStop,
  onExport,
}: HeaderBarProps) {
  const progress = selectedBook?.analysis_progress
  const done = progress?.chapters_done?.length
  const total = selectedBook?.total_chapters
  const progressBit =
    done != null && total
      ? ` · 已入账 ${done}/${total} 章`
      : ''

  return (
    <header className="top">
      <div className="brand">
        <h1>织影</h1>
        <span className="sub">ZhiYing</span>
      </div>

      {selectedBook ? (
        <div className="identity">
          <strong title={selectedBook.title}>{selectedBook.title}</strong>
          <span>
            {selectedBook.author || '未知作者'}
            {selectedBook.total_chapters ? ` · ${selectedBook.total_chapters} 章` : ''}
            {' · '}
            {statusLabel(selectedBook.status)}
            {progressBit}
          </span>
        </div>
      ) : (
        <div className="identity muted">
          <strong>人物关系图谱</strong>
          <span>上传一部书，或从案头选一本</span>
        </div>
      )}

      {!isRunning && graph && <PersonSearch graph={graph} onPick={onPickPerson} />}

      <div className="actions">
        <label className="btn file-btn">
          上传
          <input
            type="file"
            accept=".epub"
            hidden
            onChange={(e: FormEvent<HTMLInputElement>) => {
              void onUpload(e.currentTarget.files?.[0] ?? null)
              e.currentTarget.value = ''
            }}
          />
        </label>
        {isRunning ? (
          <button type="button" className="btn danger" onClick={() => void onStop()}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            disabled={!bookId}
            onClick={() => void onAnalyze()}
          >
            启动分析
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={!bookId || isRunning || exporting}
          onClick={() => void onExport()}
          title="下载 JSON：人名册、势力、图、各章账本"
        >
          {exporting ? '导出中…' : '导出'}
        </button>
      </div>
    </header>
  )
}
