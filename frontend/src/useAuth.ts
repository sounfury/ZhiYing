/** 会话上下文与读取 hook；页面共享当前账号、账号窗口入口和身份版本。 */
import { createContext, useContext } from 'react'
import type { LoginInput, RegisterInput, User } from './authApi'

export type AccountView = 'login' | 'register' | 'account' | 'admin'
export type AuthState = {
  user: User | null
  ready: boolean
  error: string
  revision: number
  view: AccountView | null
  notice: string
  openAccount: (view?: AccountView) => void
  closeAccount: () => void
  refresh: () => Promise<void>
  signIn: (input: LoginInput) => Promise<void>
  signUp: (input: RegisterInput) => Promise<void>
  signOut: () => Promise<void>
}
export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return auth
}
