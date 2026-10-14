/** 管理员用量页签：按配置时区展示每日用量、累计用户与条目用量，以及只读额度。 */
import { useEffect, useState } from 'react'
import { getBookUsage, getDailyUsage, getUserUsage, type BookUsage, type UsageDashboard, type UserUsage } from './adminApi'

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
      setData(daily); setUsers(people); setBooks(items)
    }).catch((e: unknown) => {
      if (active) setError(e instanceof Error ? e.message : String(e))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refresh])
  return <section className="admin-content" aria-label="用量看板">
    <div className="account-heading"><h2>用量</h2><button type="button" className="btn" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>刷新</button></div>
    {loading && <p role="status">正在加载用量…</p>}
    {error && <p className="account-error" role="alert">{error}</p>}
    {data && <>
      <p>今日全站 <b>{data.daily.at(-1)?.tokens.toLocaleString() ?? 0}</b> token（含未结算任务），按 {data.timeZone} 统计。</p>
      <p className="hint">额度由部署配置调整，0 表示不限。每人书数 {data.limits.maxBooks} 本；累计分析 {data.limits.maxAnalysisChars.toLocaleString()} 字；文件 {(data.limits.maxFileBytes / 1024 / 1024).toLocaleString()} MiB；同时分析 {data.limits.maxConcurrentTasks} 本；全站每日 {data.limits.dailyTokenBudget.toLocaleString()} token。</p>
      <div className="account-table-wrap"><table className="account-table"><caption>近 30 天每日 token</caption><thead><tr><th>日期</th><th>token</th></tr></thead><tbody>{data.daily.map((day) => <tr key={day.date}><td>{day.date}</td><td>{day.tokens.toLocaleString()}</td></tr>)}</tbody></table></div>
    </>}
    <div className="account-table-wrap"><table className="account-table"><caption>按用户累计（删除书仍保留用量）</caption><thead><tr><th>用户</th><th>分析字数</th><th>token</th><th>书数</th></tr></thead><tbody>{users.map((u) => <tr key={u.userId}><td>{u.username}</td><td>{u.chars.toLocaleString()}</td><td>{u.tokens.toLocaleString()}</td><td>{u.books}</td></tr>)}</tbody></table></div>
    <div className="account-table-wrap"><table className="account-table"><caption>按书架条目累计 token</caption><thead><tr><th>书名</th><th>用户</th><th>token</th></tr></thead><tbody>{books.map((b) => <tr key={b.itemId}><td>{b.title}</td><td>{b.username}</td><td>{b.tokens.toLocaleString()}</td></tr>)}</tbody></table></div>
  </section>
}
