/** 账号与管理员接口；凭据只通过请求体交给后端，登录由 HttpOnly cookie 保持。 */
import { request, send } from './api'

export type User = { id: string; username: string; role: 'ADMIN' | 'USER' }
/** maxBooks / maxTokens：被邀请用户的上限，null 沿用全站设置，0 不限 */
export type Invitation = { code: string; maxUses: number; usedCount: number; maxBooks: number | null; maxTokens: number | null }
export type InvitationInput = Pick<Invitation, 'maxUses' | 'maxBooks' | 'maxTokens'>
export type LoginInput = { username: string; password: string }
export type RegisterInput = LoginInput & { inviteCode: string }

const json = (body: Record<string, unknown>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const getMe = () => request<{ user: User | null }>('/api/auth/me')
export const login = (input: LoginInput) => request<{ user: User }>('/api/auth/login', json(input))
export const register = (input: RegisterInput) => request<{ user: User }>('/api/auth/register', json(input))
export const logout = () => send('/api/auth/logout', { method: 'POST' })
export const listInvitations = () => request<{ invitations: Invitation[] }>('/api/admin/invitations')
export const createInvitation = (input: InvitationInput) => request<Invitation>('/api/admin/invitations', json(input))
export const listUsers = () => request<{ users: User[] }>('/api/admin/users')
export const resetPassword = (userId: string, password: string) =>
  send(`/api/admin/users/${encodeURIComponent(userId)}/password`, json({ password }))
