/** 后台接口：用量聚合与模型名 / 思考覆盖，连接信息始终由部署配置提供。 */
import { apiFetch, readError, request } from '../api'

export type ModelSetting = { callPoint: 'READING' | 'POST_PROCESS' | 'AFFILIATION'; model: string; thinking: boolean; source: string }
export type UsageDashboard = {
  daily: { date: string; tokens: number }[]
  limits: { maxBooks: number; maxAnalysisChars: number; maxFileBytes: number; maxConcurrentTasks: number; dailyTokenBudget: number }
  timeZone: string
}
export type UserUsage = { userId: string; username: string; chars: number; tokens: number; books: number }
export type BookUsage = { itemId: string; username: string; title: string; tokens: number }
export type ProbeReport = { model: string; thinking: string; passed: boolean; checks: { check: string; passed: boolean; elapsedMs: number; failure: string | null; detail: string }[] }

export const getDailyUsage = () => request<UsageDashboard>('/api/admin/usage/daily?days=30')
export const getUserUsage = () => request<UserUsage[]>('/api/admin/usage/users')
export const getBookUsage = () => request<BookUsage[]>('/api/admin/usage/books')
export const getModels = () => request<ModelSetting[]>('/api/admin/models')
export const saveModel = (setting: ModelSetting) => request<void>(`/api/admin/models/${setting.callPoint}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: setting.model, thinking: setting.thinking }),
})
export const resetModel = (point: ModelSetting['callPoint']) => request<void>(`/api/admin/models/${point}`, { method: 'DELETE' })
export async function probeModel(setting: ModelSetting): Promise<ProbeReport> {
  const res = await apiFetch(`/api/diagnostics/model?${new URLSearchParams({ model: setting.model, thinking: setting.thinking ? 'enabled' : 'disabled' })}`)
  if (!res.ok && res.status !== 502) throw new Error(await readError(res))
  return res.json() as Promise<ProbeReport>
}
