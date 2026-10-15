/** 页面路由与会话边界：账号变化重建图谱状态，/admin 复用现有管理员身份校验，其余路径显示 404。 */
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
  if (!isAdmin && path !== apiUrl('')) return <NotFound />
  return <>
    {auth.error ? <div className="page-status">
      <p role="alert">{auth.error}</p>
      <button type="button" className="btn" onClick={() => void auth.refresh()}>重新加载账号</button>
    </div> : !auth.ready ? <p className="page-status" role="status">正在加载账号…</p>
      : isAdmin ? <AdminRoute key={auth.revision} /> : <App key={auth.revision} />}
    {auth.view && <AccountDialog key={`${auth.revision}:${auth.view}`} />}
  </>
}

function AdminRoute() {
  const { user } = useAuth()
  return user?.role === 'ADMIN' ? (
    <Suspense fallback={<p className="page-status" role="status">正在加载后台…</p>}>
      <AdminPage />
    </Suspense>
  ) : (
    <div className="page-status">
      <p>后台仅对管理员开放。</p>
      <div className="actions">
        {!user && <AccountButton />}
        <a className="btn ghost" href={apiUrl('/')}>返回图谱</a>
      </div>
    </div>
  )
}

function NotFound() {
  return <main className="page-status">
    <h1>404</h1>
    <p>这个页面不存在，可能是链接写错了。</p>
    <div className="actions"><a className="btn primary" href={apiUrl('/')}>返回图谱</a></div>
  </main>
}
