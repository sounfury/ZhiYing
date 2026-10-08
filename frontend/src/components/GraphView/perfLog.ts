/**
 * 开发用性能日志：开发模式下地址带 ?perf=1（或 &perf=1）才开启，输出到控制台，前缀 [zy-perf]。
 * 记录超过 50ms 的长任务、超过 100ms 的帧间隔、建图 / 样式重算 / 绘制耗时、拖动起止，用来定位卡顿。
 * 拖动结束才将帧间隔、输入延迟、绘制耗时及该次拖动的 JS 采样回传本机开发服务器，不包含书籍正文。
 */

const ENABLED = (() => {
  if (!import.meta.env.DEV) return false
  try {
    return new URLSearchParams(window.location.search).get('perf') === '1'
  } catch {
    return false
  }
})()

const session = ENABLED ? crypto.randomUUID() : ''
const pending: { at: number; message: string; data?: Record<string, unknown> }[] = []
let dragNumber = 0
let drag: {
  start: number
  lastFrame: number
  gaps: number[]
  paints: number[]
  moves: number
  maxInputDelay: number
} | null = null

/** 距页面加载的毫秒数，日志里对时间用 */
const at = () => `${(performance.now() / 1000).toFixed(2)}s`

export function perfOn(): boolean {
  return ENABLED
}

/** 输出一条日志（未开启时什么也不做） */
export function perfLog(msg: string, data?: Record<string, unknown>) {
  if (!ENABLED) return
  pending.push({ at: performance.now(), message: msg, data })
  if (pending.length > 100) pending.shift()
  if (data) console.log(`[zy-perf ${at()}] ${msg}`, data)
  else console.log(`[zy-perf ${at()}] ${msg}`)
}

/** 只收集实际拖动区间，避免把首次加载和字体测量算进首次拖动。 */
export function beginPerfPan() {
  if (!ENABLED) return
  const now = performance.now()
  drag = { start: now, lastFrame: now, gaps: [], paints: [], moves: 0, maxInputDelay: 0 }
  dragNumber++
}

export function recordPerfMove(event: PointerEvent) {
  if (!drag) return
  drag.moves++
  drag.maxInputDelay = Math.max(drag.maxInputDelay, performance.now() - event.timeStamp)
}

/** 绘制耗时只记录 JS 提交画布指令的时间，GPU 合成耗时仍需浏览器性能面板确认。 */
export function recordPerfPaint(duration: number) {
  if (drag && drag.paints.length < 3600) drag.paints.push(duration)
}

export function endPerfPan(container: HTMLElement) {
  const current = drag
  if (!ENABLED || !current) return
  drag = null
  const end = performance.now()
  perfLog(`第 ${dragNumber} 次拖动统计`, {
    duration: end - current.start,
    frames: summarize(current.gaps),
    canvasDraw: summarize(current.paints),
    moves: current.moves,
    maxInputDelay: current.maxInputDelay,
    pixelRatio: window.devicePixelRatio,
    viewport: [window.innerWidth, window.innerHeight],
    canvases: [...container.querySelectorAll('canvas')].map((c) => ({
      pixels: [c.width, c.height], css: [c.clientWidth, c.clientHeight],
    })),
  })
  void dumpProfile(`第 ${dragNumber} 次拖动`, current.start, end)
    .catch(() => perfLog('本次 JS 采样不可用，仍保留帧统计'))
    .finally(flushReport)
}

/** 计时：返回结束函数，结束时耗时超过 [minMs] 才输出 */
export function perfTime(label: string, minMs = 0): (data?: Record<string, unknown>) => number {
  if (!ENABLED) return () => 0
  const t0 = performance.now()
  return (data) => {
    const ms = performance.now() - t0
    if (ms >= minMs) perfLog(`${label} ${ms.toFixed(1)}ms`, data)
    return ms
  }
}

let installed = false

/** 全局监视：长任务与卡帧。重复调用只装一次 */
export function installPerfWatch() {
  if (!ENABLED || installed) return
  installed = true
  perfLog('性能日志已开启：拖动结束后会将统计保存到本机 frontend/.vite/graph-perf.log')
  perfLog(startProfiler() ? 'JS 采样已开启：每次拖动结束输出最耗时的函数' : '浏览器不支持 JS 采样（Firefox 不支持，请用 Chrome / Edge）')
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        perfLog(`长任务 ${e.duration.toFixed(0)}ms，开始于 ${(e.startTime / 1000).toFixed(2)}s`)
      }
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    perfLog('浏览器不支持长任务监视')
  }
  let last = performance.now()
  const tick = (t: number) => {
    if (drag && t >= drag.lastFrame) {
      if (drag.gaps.length < 3600) drag.gaps.push(t - drag.lastFrame)
      drag.lastFrame = t
    }
    if (t - last > 100 && document.visibilityState === 'visible') {
      perfLog(`卡帧 ${(t - last).toFixed(0)}ms，从 ${(last / 1000).toFixed(2)}s 起`)
    }
    last = t
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// ── JS 采样（Chrome / Edge；开发服务器已发 Document-Policy: js-profiling）──

type Trace = {
  frames: { name?: string; resourceId?: number; line?: number }[]
  resources: string[]
  samples: { timestamp: number; stackId?: number }[]
  stacks: { frameId: number; parentId?: number }[]
}
type JsProfiler = { stop(): Promise<Trace> }
let profiler: JsProfiler | null = null

function startProfiler() {
  const Ctor = (window as unknown as { Profiler?: new (o: { sampleInterval: number; maxBufferSize: number }) => JsProfiler }).Profiler
  if (!Ctor) return false
  try {
    profiler = new Ctor({ sampleInterval: 5, maxBufferSize: 200000 })
    return true
  } catch (e) {
    perfLog(`JS 采样启动失败：${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/** 输出指定拖动区间最耗时的函数（自身耗时与含子调用耗时各前 12），然后重新开始采样。 */
async function dumpProfile(label: string, from: number, until: number) {
  if (!ENABLED || !profiler) return
  const p = profiler
  profiler = null
  const trace = await p.stop()
  startProfiler()
  const frameName = (id: number) => {
    const f = trace.frames[id]
    const file = f.resourceId != null ? (trace.resources[f.resourceId] ?? '').split('/').pop()?.split('?')[0] : ''
    return `${f.name || '(匿名)'} ${file}:${f.line ?? ''}`
  }
  const self = new Map<string, number>()
  const total = new Map<string, number>()
  let busy = 0
  for (let i = 0; i < trace.samples.length; i++) {
    const s = trace.samples[i]
    if (s.stackId == null || s.timestamp < from || s.timestamp > until) continue
    const dt = Math.max(0, Math.min(until, trace.samples[i + 1]?.timestamp ?? s.timestamp + 5) - s.timestamp)
    busy += dt
    let st: number | undefined = s.stackId
    const top = frameName(trace.stacks[st].frameId)
    self.set(top, (self.get(top) ?? 0) + dt)
    const seen = new Set<string>()
    while (st != null) {
      const n = frameName(trace.stacks[st].frameId)
      if (!seen.has(n)) {
        seen.add(n)
        total.set(n, (total.get(n) ?? 0) + dt)
      }
      st = trace.stacks[st].parentId
    }
  }
  const fmt = (m: Map<string, number>) =>
    [...m].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `  ${v.toFixed(0)}ms  ${k}`).join('\n')
  perfLog(`${label}：JS 忙 ${busy.toFixed(0)}ms\n自身耗时最多：\n${fmt(self)}\n含子调用耗时最多：\n${fmt(total)}`)
}

// ===== 私有方法 =====

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    max: sorted.at(-1) ?? 0,
    over50: sorted.filter((n) => n > 50).length,
  }
}

function flushReport() {
  if (!pending.length) return
  const entries = pending.splice(0)
  void fetch('/__zy_perf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, userAgent: navigator.userAgent, entries }),
  }).catch(() => { /* 开发日志发送失败不影响图谱交互。 */ })
}
