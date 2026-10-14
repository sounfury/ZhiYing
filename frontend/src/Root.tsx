/** 页面路由：/eval 为评测页（按需加载，不进主包），其余为图谱主界面。 */
import { Suspense, lazy, useEffect, useState } from 'react'
import { apiUrl, listBooks } from './api'
import App from './App.tsx'

const EvalPage = lazy(() => import('./eval/EvalPage.tsx'))

export default function Root() {
  const isEval = window.location.pathname.replace(/\/+$/, '') === '/eval'
  return isEval ? <EvalRoute /> : <App />
}

function EvalRoute() {
  const [allowed, setAllowed] = useState<boolean | null>(null)
  useEffect(() => {
    void listBooks().then((data) => setAllowed(!data.public_only)).catch(() => setAllowed(false))
  }, [])
  if (allowed === null) return <p role="status">正在加载…</p>
  return allowed ? (
    <Suspense fallback={null}>
      <EvalPage />
    </Suspense>
  ) : (
    <p>当前只开放示例书浏览。<a href={apiUrl('/')}>返回书架</a></p>
  )
}
