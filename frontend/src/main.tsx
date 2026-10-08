/** 前端入口：先套设计令牌与基础样式（须在 App 之前引入，组件样式才能覆盖基础样式），再挂载页面路由。 */
import './styles/tokens.css'
import './styles/base.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Root from './Root.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
