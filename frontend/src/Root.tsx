/** 页面路由：/eval 为评测页（按需加载，不进主包），其余为图谱主界面。 */
import { Suspense, lazy } from 'react'
import App from './App.tsx'

const EvalPage = lazy(() => import('./eval/EvalPage.tsx'))

export default function Root() {
  const isEval = window.location.pathname.replace(/\/+$/, '') === '/eval'
  return isEval ? (
    <Suspense fallback={null}>
      <EvalPage />
    </Suspense>
  ) : (
    <App />
  )
}
