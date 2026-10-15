/** 管理员用量页签：按配置时区展示今日与近 30 天用量、只读额度，以及累计用户与条目用量。 */
import { useEffect, useState } from 'react'
import { getBookUsage, getDailyUsage, getUserUsage, type BookUsage, type UsageDashboard, type UserUsage } from './adminApi'

const fmt = (n: number) => n.toLocaleString()
const limit = (n: number, unit: string) => (n > 0 ? `${fmt(n)} ${unit}` : '不限')

export default function UsagePanel() {
  const [data, setData] = useState<UsageDashboard | null>(null)
  const [users, setUsers] = useState<UserUsage[]>([])
  const [books, setBooks] = useState<BookUsage[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void Promise.all([getDailyUsage(), getUserUsage(), getBookUsage()]).then(([daily, people, items]) => {
      if (!active) return
      setData(daily)
      setUsers([...people].sort((a, b) => b.tokens - a.tokens))
      setBooks([...items].sort((a, b) => b.tokens - a.tokens))
    }).catch((e: unknown) => {
      if (active) setError(e instanceof Error ? e.message : String(e))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refresh])
  const today = data?.daily.at(-1)?.tokens ?? 0
  const total = data?.daily.reduce((sum, d) => sum + d.tokens, 0) ?? 0
  const budget = data?.limits.dailyTokenBudget ?? 0
  const peak = Math.max(0, ...(data?.daily.map((d) => d.tokens) ?? []))
  const ratio = budget > 0 ? Math.min(1, today / budget) : 0
  return <section className="adm-page" aria-label="用量看板">
    <header className="adm-page-head">
      <div><h2>用量</h2><p className="hint">{data ? `按 ${data.timeZone} 统计，今日数据含未结算任务。` : '全站 token 消耗与额度。'}</p></div>
      <button type="button" className="btn" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>{loading ? '正在刷新…' : '刷新'}</button>
    </header>
    {error && <p className="adm-note err" role="alert">{error}</p>}
    {!data && loading && <p className="adm-empty" role="status">正在加载用量…</p>}
    {data && <>
      <div className="adm-stats">
        <div className="adm-card adm-stat">
          <span>今日 token</span><strong>{fmt(today)}</strong>
          {budget > 0 ? <><small>全站每日额度 {fmt(budget)}，已用 {Math.round(ratio * 100)}%</small><div className={`adm-meter${ratio >= 0.8 ? ' warn' : ''}`}><i style={{ width: `${ratio * 100}%` }} /></div></> : <small>每日额度不限</small>}
        </div>
        <div className="adm-card adm-stat"><span>近 30 天 token</span><strong>{fmt(total)}</strong><small>日均 {fmt(Math.round(total / Math.max(1, data.daily.length)))}</small></div>
        <div className="adm-card adm-stat"><span>用户</span><strong>{users.length}</strong><small>书架条目 {books.length} 个</small></div>
      </div>
      <div className="adm-card">
        <div className="adm-card-head"><h3>近 30 天每日 token</h3><span className="hint">峰值 {fmt(peak)}</span></div>
        <div className="adm-chart" role="img" aria-label="近 30 天每日 token 柱状图">
          {data.daily.map((d) => <div key={d.date} title={`${d.date}：${fmt(d.tokens)} token`}><i style={{ height: `${peak ? (d.tokens / peak) * 100 : 0}%` }} /></div>)}
        </div>
        <div className="adm-chart-axis"><span>{data.daily[0]?.date}</span><span>{data.daily.at(-1)?.date}</span></div>
      </div>
      <div className="adm-card">
        <div className="adm-card-head"><div><h3>额度</h3><p className="hint">由部署配置调整，此处只读。</p></div></div>
        <dl className="adm-limits">
          <div><dt>每人书数</dt><dd>{limit(data.limits.maxBooks, '本')}</dd></div>
          <div><dt>每人累计分析</dt><dd>{limit(data.limits.maxAnalysisChars, '字')}</dd></div>
          <div><dt>单个文件</dt><dd>{limit(data.limits.maxFileBytes / 1024 / 1024, 'MiB')}</dd></div>
          <div><dt>同时分析</dt><dd>{limit(data.limits.maxConcurrentTasks, '本')}</dd></div>
          <div><dt>全站每日</dt><dd>{limit(budget, 'token')}</dd></div>
        </dl>
      </div>
    </>}
    {!loading && !error && <div className="adm-grid">
      <div className="adm-card">
        <div className="adm-card-head"><div><h3>按用户累计</h3><p className="hint">删除书后用量仍保留。</p></div></div>
        {users.length === 0 ? <p className="adm-empty">暂无用户用量</p> : <div className="adm-table-wrap"><table className="adm-table">
          <thead><tr><th>用户</th><th className="num">分析字数</th><th className="num">token</th><th className="num">书数</th></tr></thead>
          <tbody>{users.map((u) => <tr key={u.userId}><td>{u.username}</td><td className="num">{fmt(u.chars)}</td><td className="num">{fmt(u.tokens)}</td><td className="num">{u.books}</td></tr>)}</tbody>
        </table></div>}
      </div>
      <div className="adm-card">
        <div className="adm-card-head"><div><h3>按书架条目累计</h3><p className="hint">按 token 从高到低。</p></div></div>
        {books.length === 0 ? <p className="adm-empty">暂无条目用量</p> : <div className="adm-table-wrap"><table className="adm-table">
          <thead><tr><th>书名</th><th>用户</th><th className="num">token</th></tr></thead>
          <tbody>{books.map((b) => <tr key={b.itemId}><td className="clip" title={b.title}>{b.title}</td><td>{b.username}</td><td className="num">{fmt(b.tokens)}</td></tr>)}</tbody>
        </table></div>}
      </div>
    </div>}
  </section>
}
