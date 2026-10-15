/** 后台统一入口：左侧导航切换用量、模型、评测、账号与反馈，仅由管理员路由挂载。 */
import { Suspense, lazy, useEffect, useState } from 'react'
import { apiUrl } from '../api'
import { AccountButton } from '../components/AccountDialog'
import UsagePanel from './UsagePanel'
import ModelsPanel from './ModelsPanel'
import AccountsPanel from './AccountsPanel'
import FeedbackPanel from './FeedbackPanel'
import './admin.css'

const EvalPage = lazy(() => import('../eval/EvalPage'))
const TABS = { usage: '用量', models: '模型', eval: '评测', accounts: '账号', feedback: '反馈' }
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
  useEffect(() => { document.title = `${TABS[tab]} · 织影后台` }, [tab])
  const select = (next: Tab) => {
    if (next === tab) return
    window.history.pushState(null, '', apiUrl(`/admin?tab=${next}`))
    setTab(next)
    window.scrollTo(0, 0)
  }
  return <div className="adm">
    <aside className="adm-side">
      <h1 className="adm-brand">织影<small>后台</small></h1>
      <nav className="adm-nav" aria-label="后台页签">{(Object.keys(TABS) as Tab[]).map((key) => <button type="button" key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => select(key)}>{TABS[key]}</button>)}</nav>
      <div className="adm-side-foot"><AccountButton /><a className="btn ghost" href={apiUrl('/')}>← 返回图谱</a></div>
    </aside>
    <main className="adm-main">
      {tab === 'usage' && <UsagePanel />}
      {tab === 'models' && <ModelsPanel />}
      {tab === 'accounts' && <AccountsPanel />}
      {tab === 'feedback' && <FeedbackPanel />}
      {tab === 'eval' && <Suspense fallback={<p className="adm-empty" role="status">正在加载评测…</p>}><EvalPage /></Suspense>}
    </main>
  </div>
}
