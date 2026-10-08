/**
 * 报告总览（仪表盘）：总分环与运行信息、得分构成（每项得分 / 满分）、必有关系分档（强 / 中 / 弱的权重与找到比例）、
 * 各章状态格、诊断、标注自检与人物对齐。
 */
import { useMemo } from 'react'
import type { ChapterReport, EvalRun, Metric, TierStat } from './evalApi'
import type { Pane } from './ReportView'
import { TIER_LABEL, chapterProblems, isSatisfied } from './report'
import { Delta } from './parts'
import { formatDuration, formatTime, formatTokens, pct } from './format'

/** 指标口径的白话说明（DESIGN §7.3） */
const METRIC_HELP: Record<string, string> = {
  person_recall: '标准列出的主要人物，在结果里按名字能找到的比例',
  identity: '主要人物没有被拆成多个节点、也没有和别人并成一个节点',
  required_recall: '标准要求必须找出的关系，按强 / 中 / 弱分档加权',
  forbidden_avoided: '标准认定不成立的关系，结果没有犯的比例',
  direction: '找到的有向关系（如师傅 → 徒弟）方向正确的比例',
  quoted: '找到的必有关系里，带原文引用的比例',
  optional_coverage: '合理但偏弱的关系找到了多少',
  adjudicated_precision: '标准涉及的人物之间，结果给的关系有多少是对的',
  unlabeled: '结果里有、标准没涉及的记录占比；高说明标准该扩充',
  withheld: '未决或被否定、不上图的记录占比',
}

const TIER_HELP: Record<string, string> = {
  HARD: '亲属、婚恋、师徒等；漏掉全额扣分',
  MEDIUM: '主仆、商业、同门、恩人等；漏掉按权重扣分',
  SOFT: '朋友、相识等；两人已有强 / 中关系时漏掉不扣',
}

type Props = { run: EvalRun; previous: EvalRun | null; onPane: (pane: Pane) => void }

export function Overview({ run, previous, onPane }: Props) {
  const r = run.report
  const prev = useMemo(
    () => new Map((previous ? [...previous.report.metrics, ...previous.report.diagnostics] : []).map((m) => [m.key, m])),
    [previous],
  )
  const prevTiers = useMemo(() => new Map((previous?.report.tiers ?? []).map((t) => [t.tier, t])), [previous])
  const problems = r.chapters.filter((c) => chapterProblems(c) > 0).length
  const violations = r.chapters.reduce((n, c) => n + c.forbidden.filter((f) => f.violated).length, 0)
  const lost = r.metrics.reduce((sum, m) => sum + m.weight * (1 - (m.value ?? 1)), 0)

  return (
    <div className="ov">
      <section className="card ov-hero">
        <ScoreRing score={r.score} />
        <div className="ov-hero-main">
          <div className="ov-hero-title">
            总分 <b>{r.score.toFixed(1)}</b>
            {previous && <Delta value={r.score - previous.report.score} digits={1} />}
            <span className="hint">共丢 {lost.toFixed(1)} 分</span>
          </div>
          <div className="ov-chips">
            <span>{formatTime(run.created_at)}</span>
            <span>{run.model}</span>
            {run.usage && <span>{run.usage.requests} 次请求</span>}
            {run.usage && <span>{formatTokens(run.usage.total_tokens)} token</span>}
            {run.duration_seconds != null && <span>耗时 {formatDuration(run.duration_seconds)}</span>}
            {run.task_kind === 'RERUN' && <span>单章重跑后</span>}
          </div>
          {previous && <div className="hint">差值对比上一次运行（{formatTime(previous.created_at)}）</div>}
        </div>
        <div className="ov-hero-stats">
          <Stat label="有问题的章" value={`${problems} / ${r.chapters.length}`} bad={problems > 0} />
          <Stat label="禁止项违反" value={String(violations)} bad={violations > 0} />
          <Stat label="结果人物" value={String(r.persons.length)} />
        </div>
      </section>

      {r.gold_issues.length > 0 && (
        <section className="card ov-issues">
          <h3>标注自检</h3>
          <ul>
            {r.gold_issues.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="ov-grid">
        <section className="card">
          <h3>得分构成</h3>
          <p className="hint ov-sub">每项比例 × 权重 = 得分；总分只用于同一评测集前后对比。</p>
          {r.metrics.map((m) => (
            <ScoreRow key={m.key} metric={m} prev={prev.get(m.key)} />
          ))}
        </section>

        <section className="card">
          <h3>必有关系分档</h3>
          <p className="hint ov-sub">按关系强弱给不同权重，汇成「必有关系召回」。</p>
          {r.tiers?.length ? (
            <div className="ov-tiers">
              {r.tiers.map((t) => (
                <TierCard key={t.tier} stat={t} prev={prevTiers.get(t.tier)} />
              ))}
            </div>
          ) : (
            <p className="hint">这次运行记录较旧，没有分档统计；重新「评测当前结果」即可看到。</p>
          )}
        </section>
      </div>

      <section className="card">
        <h3>各章</h3>
        <p className="hint ov-sub">点格子查看该章详情；分数为必有关系找到数（含不扣分的弱关系）。</p>
        <div className="ov-chapters">
          {r.chapters.map((c) => (
            <ChapterTile key={c.number} chapter={c} onClick={() => onPane(c.number)} />
          ))}
        </div>
      </section>

      <section className="card">
        <h3>诊断（不计分）</h3>
        <div className="ov-diag">
          {r.diagnostics.map((m) => (
            <div key={m.key} className="ov-diag-item">
              <div className="ov-diag-v">
                {pct(m.value)}
                {prev.get(m.key) && <Delta value={((m.value ?? 0) - (prev.get(m.key)!.value ?? 0)) * 100} digits={1} unit="%" />}
              </div>
              <div className="ov-diag-label">
                {m.label}
                <span className="hint">
                  {' '}
                  {m.hit} / {m.total}
                </span>
              </div>
              <div className="hint">{METRIC_HELP[m.key]}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>人物</h3>
        <p className="hint ov-sub">标准只列主要人物，按名字与别名对齐；结果共 {r.persons.length} 人，其余不计分。</p>
        <div className="ov-people">
          {r.people.map((p) => {
            const bad = p.matched.length !== 1
            return (
              <div key={p.gold} className={`ov-person${bad ? ' bad' : ''}`}>
                <div className="ov-person-name">
                  {p.gold}
                  {p.matched.length === 0 && <span className="rv-tag err">缺人物</span>}
                  {p.matched.length > 1 && <span className="rv-tag err">拆成 {p.matched.length} 个</span>}
                </div>
                {p.matched.map((m) => (
                  <div key={m.id} className="hint">
                    {m.name}
                    {m.aliases.length > 0 && `：${m.aliases.join('、')}`}
                  </div>
                ))}
              </div>
            )
          })}
          {r.wrong_merges.map((w) => (
            <div key={w.person.id} className="ov-person bad">
              <div className="ov-person-name">
                {w.person.name}
                <span className="rv-tag err">误合</span>
              </div>
              <div className="hint">同时对上 {w.golds.join('、')}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

/** 分数等级：决定环与条的颜色 */
const grade = (ratio: number) => (ratio >= 0.9 ? 'good' : ratio >= 0.7 ? 'mid' : 'bad')

function ScoreRing({ score }: { score: number }) {
  const r = 46
  const c = 2 * Math.PI * r
  return (
    <svg className={`ov-ring ${grade(score / 100)}`} viewBox="0 0 120 120" role="img" aria-label={`总分 ${score.toFixed(1)}`}>
      <circle cx="60" cy="60" r={r} className="track" />
      <circle cx="60" cy="60" r={r} className="fill" strokeDasharray={`${(c * score) / 100} ${c}`} transform="rotate(-90 60 60)" />
      <text x="60" y="62" textAnchor="middle" className="num">
        {score.toFixed(1)}
      </text>
      <text x="60" y="80" textAnchor="middle" className="unit">
        / 100
      </text>
    </svg>
  )
}

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="ov-stat">
      <div className={`ov-stat-v${bad ? ' bad' : ''}`}>{value}</div>
      <div className="hint">{label}</div>
    </div>
  )
}

function Bar({ ratio }: { ratio: number }) {
  return (
    <div className={`ov-bar ${grade(ratio)}`}>
      <i style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }} />
    </div>
  )
}

function ScoreRow({ metric: m, prev }: { metric: Metric; prev?: Metric }) {
  const ratio = m.value ?? 1
  return (
    <div className="ov-row">
      <div className="ov-row-head">
        <span className="ov-row-label">{m.label}</span>
        <span className="ov-row-pts">
          <b>{(m.weight * ratio).toFixed(1)}</b>
          <span className="hint"> / {m.weight} 分</span>
          {prev && <Delta value={((m.value ?? 1) - (prev.value ?? 1)) * m.weight} digits={1} />}
        </span>
      </div>
      <Bar ratio={ratio} />
      <div className="ov-row-foot hint">
        <span>
          {pct(m.value)} · {m.hit}/{m.total}
        </span>
        <span>{METRIC_HELP[m.key]}</span>
      </div>
    </div>
  )
}

function TierCard({ stat: t, prev }: { stat: TierStat; prev?: TierStat }) {
  const ratio = t.total ? t.hit / t.total : null
  const prevRatio = prev && prev.total ? prev.hit / prev.total : null
  return (
    <div className={`ov-tier tier-${t.tier.toLowerCase()}`}>
      <div className="ov-tier-head">
        <b>{TIER_LABEL[t.tier]}</b>
        <span className="ov-weight">权重 {t.weight}</span>
      </div>
      <div className="ov-tier-v">
        {pct(ratio)}
        {ratio != null && prevRatio != null && <Delta value={(ratio - prevRatio) * 100} digits={1} unit="%" />}
      </div>
      <Bar ratio={ratio ?? 1} />
      <div className="ov-tier-count">
        找到 {t.hit} / {t.total}
        {t.excused > 0 && <span className="hint">，另 {t.excused} 条不扣分</span>}
      </div>
      <div className="hint ov-tier-help">{TIER_HELP[t.tier]}</div>
    </div>
  )
}

function ChapterTile({ chapter: c, onClick }: { chapter: ChapterReport; onClick: () => void }) {
  const n = chapterProblems(c)
  const satisfied = c.required.filter(isSatisfied).length
  return (
    <button type="button" className={`ov-tile${n ? ' bad' : ''}`} onClick={onClick}>
      <span className="ov-tile-no hint">第 {c.number} 章</span>
      <span className="ov-tile-title">{c.title}</span>
      <span className="ov-tile-foot">
        <span className="hint">
          必有 {satisfied}/{c.required.length}
        </span>
        {n ? <span className="rv-badge err">{n} 个问题</span> : <span className="rv-badge ok">✓</span>}
      </span>
    </button>
  )
}
