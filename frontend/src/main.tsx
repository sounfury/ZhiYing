/** 前端入口：先套设计令牌与基础样式（须在 App 之前引入，组件样式才能覆盖基础样式），再挂载 App。 */
import './styles/tokens.css'
import './styles/base.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
