/** 页面路由与会话边界：账号变化重建图谱状态，/admin 复用现有管理员身份校验。 */
import { Suspense, lazy } from 'react'
import { apiUrl } from './api'
import { AuthProvider } from './auth'
import { useAuth } from './useAuth'
import { AccountButton, AccountDialog } from './components/AccountDialog'
import App from './App.tsx'

const AdminPage = lazy(() => import('./admin/AdminPage.tsx'))

export default function Root() {
  return <AuthProvider><SessionRoutes /></AuthProvider>
}

function SessionRoutes() {
  const auth = useAuth()
  const path = window.location.pathname.replace(/\/+$/, '')
  if (path === apiUrl('/eval')) {
    window.location.replace(apiUrl('/admin?tab=eval'))
    return null
  }
  const isAdmin = path === apiUrl('/admin')
  return <>
    {!auth.ready || auth.error ? <div className="account-route-status">
      {auth.error ? <>
        <p role="alert">{auth.error}</p>
        <button type="button" className="btn" onClick={() => void auth.refresh()}>重新加载账号</button>
      </> : <p role="status">正在加载账号…</p>}
    </div> : isAdmin ? <AdminRoute key={auth.revision} /> : <App key={auth.revision} />}
    {auth.view && <AccountDialog key={`${auth.revision}:${auth.view}`} />}
  </>
}

function AdminRoute() {
  const { user } = useAuth()
  return user?.role === 'ADMIN' ? (
    <Suspense fallback={<p role="status">正在加载后台…</p>}>
      <AdminPage />
    </Suspense>
  ) : (
    <div className="account-route-status">
      <p>后台仅对管理员开放。</p>
      {!user && <AccountButton />}
      <a className="btn ghost" href={apiUrl('/')}>返回图谱</a>
    </div>
  )
}
