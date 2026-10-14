/** 后台统一入口：用量、模型、现有评测与账号工具，仅由管理员路由挂载。 */
import { Suspense, lazy, useEffect, useState } from 'react'
import { apiUrl } from '../api'
import { AccountButton } from '../components/AccountDialog'
import { AdminPanel } from '../components/AdminPanel'
import UsagePanel from './UsagePanel'
import ModelsPanel from './ModelsPanel'
import './admin.css'

const EvalPage = lazy(() => import('../eval/EvalPage'))
const TABS = { usage: '用量', models: '模型', eval: '评测', accounts: '账号' }
type Tab = keyof typeof TABS
const currentTab = (): Tab => {
  const value = new URLSearchParams(window.location.search).get('tab')
  return value && Object.keys(TABS).includes(value) ? value as Tab : 'usage'
}

export default function AdminPage() {
  const [tab, setTab] = useState(currentTab)
  useEffect(() => {
    const update = () => setTab(currentTab())
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  const select = (next: Tab) => {
    window.history.pushState(null, '', apiUrl(`/admin?tab=${next}`))
    setTab(next)
  }
  return <main className="admin-page">
    <header className="admin-header">
      <h1>后台</h1>
      <nav className="seg" aria-label="后台页签">{(Object.keys(TABS) as Tab[]).map((key) => <button type="button" key={key} className={tab === key ? 'on' : ''} aria-pressed={tab === key} onClick={() => select(key)}>{TABS[key]}</button>)}</nav>
      <div className="account-actions"><AccountButton /><a className="btn ghost" href={apiUrl('/')}>返回图谱</a></div>
    </header>
    {tab === 'usage' && <UsagePanel />}
    {tab === 'models' && <ModelsPanel />}
    {tab === 'accounts' && <section className="admin-content" aria-label="账号管理"><h2>账号</h2><AdminPanel /></section>}
    {tab === 'eval' && <Suspense fallback={<p role="status">正在加载评测…</p>}><EvalPage /></Suspense>}
  </main>
}
