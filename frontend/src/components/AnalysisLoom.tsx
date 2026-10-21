/**
 * 整书分析等待动画（PRD §5.9 等待展示）：居中一只吊丝晃荡的手绘小蜘蛛（线条逐帧抖动），
 * 下面新登场人物排队逐个「盖章」登场，还没有人物时轮播俏皮话；
 * 后处理、发布阶段只轮播该阶段的俏皮话，已登场的人名收进下方小字。
 * 下方细条是逐章经线：排队虚线、在读闪光、读完落定、失败断开，保留真实的章级信息。
 * 纯装饰部分对读屏隐藏，人名与进度另以文字输出。
 */
import { useEffect, useState } from 'react'
import type { AnalysisTaskChapter } from '../api'
import type { NewPerson } from '../types'
import { Spider } from './Spider'

/** 经线最多根数，超过时相邻章合并成一根 */
const MAX_COLS = 120
/** 当前名字下方保留的已登场人名数 */
const TRAIL = 6
/** 每个名字的停留时长；排队越多越快，追上真实进度 */
const STAY_MS = 1800
const QUIP_MS = 2400
const QUIPS = [
  '正在翻找伏笔…',
  '给配角挨个点名…',
  '核对谁是谁的表哥…',
  '辨认化名与马甲…',
  '在字里行间找人…',
  '把散落的称呼捡起来…',
  '理一理旧日恩怨…',
  '清点门派与家族…',
  '把蛛丝连成关系…',
]
/** 读完章后各阶段的俏皮话；这些阶段中间那行只轮播它们，已登场的人名全部收进下方小字 */
const PHASE_QUIPS: Record<string, string[]> = {
  post_processing: ['合并同一个人的几种叫法…', '揪出马甲背后的真身…', '给关系归归类…', '补查漏掉的线头…', '替全书写一段简介…'],
  publishing: ['把网挂起来…', '掸掉最后一点灰…', '给新图谱盖上印…'],
}
type Thread = 'pending' | 'running' | 'done' | 'reused' | 'failed'

/** 一根经线覆盖的章合并后的状态 */
function column(group: AnalysisTaskChapter[]): Thread {
  if (group.some((c) => c.status === 'failed')) return 'failed'
  const settled = group.filter((c) => c.status === 'done' || c.status === 'partial')
  if (settled.length === group.length) return settled.every((c) => c.reused) ? 'reused' : 'done'
  return group.some((c) => c.status === 'running') || settled.length ? 'running' : 'pending'
}

/** 逐字砸下来；歪斜角由字和位置决定，重渲染不跳 */
function Stamp({ text }: { text: string }) {
  return [...text].map((c, k) => (
    <span key={k} className="ch" style={{ animationDelay: `${k * 0.12}s`, ['--r' as string]: `${((c.charCodeAt(0) * 7 + k * 13) % 17) - 8}deg` }}>
      {c}
    </span>
  ))
}

/** 盖章文字的抖动滤镜：噪声种子逐帧切换 */
function TextBoil() {
  return (
    <svg width="0" height="0" className="loom-defs" aria-hidden="true">
      <filter id="loom-boil-text" x="-5%" y="-20%" width="110%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="0.08" numOctaves={1} seed="1">
          <animate attributeName="seed" values="1;2;3" dur="0.36s" repeatCount="indefinite" calcMode="discrete" />
        </feTurbulence>
        <feDisplacementMap in="SourceGraphic" scale="2" />
      </filter>
    </svg>
  )
}

interface Props {
  chapters: AnalysisTaskChapter[]
  phase: string
  newPersons: NewPerson[]
}

export function AnalysisLoom({ chapters, phase, newPersons }: Props) {
  const n = chapters.length
  const cols = Math.min(n, MAX_COLS)
  const threads = Array.from({ length: cols }, (_, i) => column(chapters.slice(Math.floor((i * n) / cols), Math.floor(((i + 1) * n) / cols))))
  const read = chapters.filter((c) => c.status === 'done' || c.status === 'partial').length

  // 已登场的人（最新一个是当前盖章的）与累计数；newPersons 只保留最近若干个，按 id 递增判断谁还没登场
  const [shown, setShown] = useState<{ list: NewPerson[]; count: number }>({ list: [], count: 0 })
  const lastId = shown.list.at(-1)?.id ?? 0
  const queue = newPersons.filter((p) => p.id > lastId)
  const next = queue[0]
  useEffect(() => {
    if (!next) return
    const t = setTimeout(
      () => setShown((s) => ({ list: [...s.list, next].slice(-TRAIL - 1), count: s.count + 1 })),
      lastId ? Math.max(300, STAY_MS / queue.length) : 200,
    )
    return () => clearTimeout(t)
  }, [next, lastId, queue.length])

  const reading = phase === 'reading' || phase === 'preparing'
  const current = PHASE_QUIPS[phase] ? undefined : shown.list.at(-1)
  const trail = current ? shown.list.slice(0, -1) : shown.list
  const quips = current ? null : (PHASE_QUIPS[phase] ?? QUIPS)
  const [quip, setQuip] = useState(0)
  useEffect(() => {
    if (!quips) return
    const t = setInterval(() => setQuip((q) => q + 1), QUIP_MS)
    return () => clearInterval(t)
  }, [quips])

  return (
    <div className={`loom phase-${phase}`}>
      <div className="loom-stage">
        <Spider className="loom-spider" />
        <TextBoil />
        <p className={`loom-line${current ? '' : ' quip'}`} key={current?.id ?? `q${quip}`} aria-hidden={!current}>
          {current ? (
            <>
              <span className="pre">新登场</span>
              <Stamp text={current.name} />
            </>
          ) : (
            quips && <Stamp text={quips[quip % quips.length]} />
          )}
        </p>
        <p className="loom-trail">
          {trail.length ? trail.map((p) => p.name).join(' · ') : reading && !current ? '读完一章，新登场的人物会出现在这里' : ''}
        </p>
        {shown.count > 0 && <p className="loom-count">已发现 {shown.count} 位人物</p>}
      </div>
      <svg className="loom-warp" viewBox={`0 0 ${Math.max(cols, 1)} 10`} preserveAspectRatio="none" aria-hidden="true">
        {threads.map((t, i) =>
          t === 'failed' ? (
            <g key={i} className="loom-thread failed">
              <line x1={i + 0.5} x2={i + 0.5} y1={0} y2={3.5} />
              <line x1={i + 0.5} x2={i + 0.5} y1={6.5} y2={10} />
            </g>
          ) : (
            <line key={i} className={`loom-thread ${t}`} x1={i + 0.5} x2={i + 0.5} y1={0} y2={10} pathLength={100} />
          ),
        )}
      </svg>
      <p className="loom-cap">
        {reading ? `已读 ${read} / ${n} 章` : '章节已读完，正在汇总'}
        <span>可以关闭页面，分析会在后台继续</span>
      </p>
    </div>
  )
}
