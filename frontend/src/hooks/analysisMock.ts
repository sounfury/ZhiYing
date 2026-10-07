/**
 * 仅开发模式用的分析进度假数据：URL 带 ?mockProgress=reading|post|failed|done|cancelled|rerun|many 时，
 * useAnalysis 用这里构造的任务快照渲染进度卡，不发任何分析请求，便于不花模型费用地检查各状态的样子。
 * 章节 ID 9–13 对应测试书《一个青年艺术家的画像》的五章，字数由页面按真实章节列表补上。
 */
import type { AnalysisTaskChapter, AnalysisTaskSnapshot } from '../api'
import type { AnalysisUi, LogLine } from '../types'

export const MOCK_KINDS = ['reading', 'post', 'failed', 'done', 'cancelled', 'rerun', 'many'] as const
export type MockKind = (typeof MOCK_KINDS)[number]

/** 读 URL 参数；非开发模式或参数不认识时返回 null */
export function readMockKind(): MockKind | null {
  if (!import.meta.env.DEV) return null
  try {
    const v = new URLSearchParams(window.location.search).get('mockProgress')
    return MOCK_KINDS.includes(v as MockKind) ? (v as MockKind) : null
  } catch {
    return null
  }
}

const TITLES = ['第一章', '第二章', '第三章', '第四章', '第五章']
const UNITS = [2, 2, 2, 2, 4]

function ch(i: number, status: string, unitsDone: number, extra: Partial<AnalysisTaskChapter> = {}): AnalysisTaskChapter {
  return {
    chapter_id: 9 + i,
    title: TITLES[i] ?? `第 ${i + 1} 章`,
    status,
    reused: false,
    units_done: unitsDone,
    units_total: UNITS[i] ?? 1,
    last_error: '',
    warnings: [],
    ...extra,
  }
}

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

function snapshot(over: Partial<AnalysisTaskSnapshot>): AnalysisTaskSnapshot {
  const chapters = over.chapters ?? []
  return {
    task_id: 'mock-task',
    kind: 'full',
    active: true,
    status: 'running',
    phase: 'reading',
    total_chapters: chapters.length,
    started_at: ago(163),
    finished_at: null,
    message: '',
    chapters,
    success_count: chapters.filter((c) => c.status === 'done' || c.status === 'partial').length,
    failure_count: chapters.filter((c) => c.status === 'failed').length,
    running_count: chapters.filter((c) => c.status === 'running').length,
    queued_count: chapters.filter((c) => c.status === 'pending').length,
    llm_requests: 134,
    input_tokens: 2_530_000,
    output_tokens: 75_000,
    total_tokens: 2_605_000,
    ...over,
  }
}

const LOGS: LogLine[] = [
  { id: 1, kind: 'info', text: '已启动分析：全书正文，共 5 章' },
  { id: 2, kind: 'info', text: '「第一章」已读 1/2 段' },
  { id: 3, kind: 'ok', text: '「第一章」完成' },
  { id: 4, kind: 'info', text: '「第五章」已读 2/4 段' },
]

function buildTask(kind: MockKind): AnalysisTaskSnapshot {
  switch (kind) {
    case 'reading':
      return snapshot({
        chapters: [
          ch(0, 'done', 2),
          ch(1, 'done', 2, { reused: true }),
          ch(2, 'running', 1),
          ch(3, 'pending', 0),
          ch(4, 'running', 2),
        ],
        llm_requests: 61,
        total_tokens: 1_184_000,
      })
    case 'post':
      return snapshot({
        phase: 'post_processing',
        chapters: [0, 1, 2, 3, 4].map((i) => ch(i, 'done', UNITS[i])),
      })
    case 'failed':
      return snapshot({
        active: false,
        status: 'failed',
        phase: 'reading',
        finished_at: ago(0),
        message: '2 章读取失败（第11章、第13章），本次未发布，上一版结果保持不变；已读成功的章抽取已保存，重新启动分析会沿用它们，只补读失败章',
        chapters: [
          ch(0, 'done', 2),
          ch(1, 'done', 2),
          ch(2, 'failed', 1, { last_error: '模型服务返回 429：请求过于频繁，重试 3 次后放弃' }),
          ch(3, 'done', 2),
          ch(4, 'failed', 3, { last_error: '提交结果校验失败：引文与原文不符（第 3 段），超过最大修正轮数' }),
        ],
      })
    case 'done':
      return snapshot({
        active: false,
        status: 'completed',
        phase: 'finished',
        started_at: ago(206),
        finished_at: ago(0),
        message: '已发布：人物 81，关系记录 109',
        chapters: [0, 1, 2, 3, 4].map((i) => ch(i, 'done', UNITS[i])),
        llm_requests: 148,
        total_tokens: 2_676_263,
      })
    case 'cancelled':
      return snapshot({
        active: false,
        status: 'cancelled',
        phase: 'reading',
        finished_at: ago(0),
        message: '已取消，本次未发布，上一版结果保持不变',
        chapters: [ch(0, 'done', 2), ch(1, 'done', 2), ch(2, 'cancelled', 1), ch(3, 'cancelled', 0), ch(4, 'cancelled', 2)],
        llm_requests: 40,
        total_tokens: 812_000,
      })
    case 'rerun':
      return snapshot({
        kind: 'rerun',
        started_at: ago(48),
        chapters: [ch(3, 'running', 1)],
        llm_requests: 9,
        total_tokens: 121_000,
      })
    case 'many': {
      const chapters = Array.from({ length: 36 }, (_, i): AnalysisTaskChapter => {
        const status = i < 22 ? 'done' : i === 24 ? 'failed' : i < 28 ? 'running' : 'pending'
        const total = 1 + (i % 4)
        return {
          chapter_id: 100 + i,
          title: `第${i + 1}回`,
          status,
          reused: i < 8,
          units_done: status === 'done' ? total : status === 'running' ? Math.min(total - 1, i % 3) : status === 'failed' ? 0 : 0,
          units_total: total,
          last_error: status === 'failed' ? '模型请求超时（120s）' : '',
          warnings: [],
        }
      })
      return snapshot({ chapters, started_at: ago(1240), llm_requests: 488, total_tokens: 9_820_000 })
    }
  }
}

/** 构造某个假状态的完整前端状态 */
export function mockAnalysis(kind: MockKind): AnalysisUi {
  const task = buildTask(kind)
  return {
    running: task.active,
    stopping: false,
    task,
    dismissed: false,
    phase: task.active ? '分析进行中（演示数据）' : '',
    logs: LOGS,
    demo: true,
  }
}
