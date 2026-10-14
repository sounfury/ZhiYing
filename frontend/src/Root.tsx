/** 页面路由与会话边界：账号变化重建图谱状态，/eval 只挂载管理员页面。 */
import { Suspense, lazy } from 'react'
import { apiUrl } from './api'
import { AuthProvider } from './auth'
import { useAuth } from './useAuth'
import { AccountButton, AccountDialog } from './components/AccountDialog'
import App from './App.tsx'

const EvalPage = lazy(() => import('./eval/EvalPage.tsx'))

export default function Root() {
  return <AuthProvider><SessionRoutes /></AuthProvider>
}

function SessionRoutes() {
  const auth = useAuth()
  const isEval = window.location.pathname.replace(/\/+$/, '') === apiUrl('/eval')
  return <>
    {!auth.ready || auth.error ? <div className="account-route-status">
      {auth.error ? <>
        <p role="alert">{auth.error}</p>
        <button type="button" className="btn" onClick={() => void auth.refresh()}>重新加载账号</button>
      </> : <p role="status">正在加载账号…</p>}
    </div> : isEval ? <EvalRoute key={auth.revision} /> : <App key={auth.revision} />}
    {auth.view && <AccountDialog key={`${auth.revision}:${auth.view}`} />}
  </>
}

function EvalRoute() {
  const { user } = useAuth()
  return user?.role === 'ADMIN' ? (
    <Suspense fallback={<p role="status">正在加载评测页…</p>}>
      <EvalPage />
    </Suspense>
  ) : (
    <div className="account-route-status">
      <p>评测与模型诊断仅对管理员开放。</p>
      {!user && <AccountButton />}
      <a className="btn ghost" href={apiUrl('/')}>返回图谱</a>
    </div>
  )
}
