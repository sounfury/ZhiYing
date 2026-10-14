/** 会话状态与账号弹窗入口；身份变化作废旧请求并重建私有数据状态。 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { resetApiSession } from './api'
import { getMe, login, logout, register, type LoginInput, type RegisterInput, type User } from './authApi'

import { AuthContext, type AccountView } from './useAuth'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const currentUser = useRef<User | null | undefined>(undefined)
  const refreshVersion = useRef(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [view, setView] = useState<AccountView | null>(null)
  const [notice, setNotice] = useState('')

  const applyUser = useCallback((next: User | null) => {
    refreshVersion.current += 1
    const previous = currentUser.current
    if (previous !== undefined && (previous?.id !== next?.id || previous?.role !== next?.role)) {
      resetApiSession()
      try {
        localStorage.removeItem('zhiying.bookId')
      } catch {
        /* 浏览器禁止存储时仍须清空内存状态。 */
      }
      const params = new URLSearchParams(window.location.search)
      if (!params.has('example')) {
        for (const key of ['book', 'focus', 'chapter', 'chapter_mode']) params.delete(key)
        const query = params.toString()
        window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash)
      }
      setRevision((n) => n + 1)
      setView(null)
    }
    currentUser.current = next
    setUser(next)
    setReady(true)
    setError('')
  }, [])

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current
    try {
      const { user: next } = await getMe()
      if (version === refreshVersion.current) applyUser(next)
    } catch (e) {
      if (version === refreshVersion.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [applyUser])

  useEffect(() => {
    const expired = () => {
      applyUser(null)
      // /me 清除过期 cookie 后再加载访客书架，避免重复 401。
      setReady(false)
      void refresh()
      setNotice('登录已过期，请重新登录。')
      setView('login')
    }
    const onFocus = () => { void refresh() }
    window.addEventListener('zhiying:session-expired', expired)
    window.addEventListener('focus', onFocus)
    void refresh()
    return () => {
      window.removeEventListener('zhiying:session-expired', expired)
      window.removeEventListener('focus', onFocus)
    }
  }, [applyUser, refresh])

  const signIn = async (input: LoginInput) => {
    const result = await login(input)
    applyUser(result.user)
    setView(null)
    setNotice('')
  }
  const signUp = async (input: RegisterInput) => {
    const result = await register(input)
    applyUser(result.user)
    setView(null)
    setNotice('')
  }
  const signOut = async () => {
    await logout()
    applyUser(null)
    setView(null)
    setNotice('')
  }

  return (
    <AuthContext.Provider value={{
      user, ready, error, revision, view, notice, refresh, signIn, signUp, signOut,
      openAccount: (next) => { setNotice(''); setView(next ?? (user ? 'account' : 'login')) },
      closeAccount: () => { setView(null); setNotice('') },
    }}>
      {children}
    </AuthContext.Provider>
  )
}
