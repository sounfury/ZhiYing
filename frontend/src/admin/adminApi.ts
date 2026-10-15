/** 后台接口：用量聚合、各分析环节的服务商 / 模型 / 思考覆盖，以及模型服务商管理（密钥只写不读）。 */
import { apiFetch, readError, request } from '../api'

export type ModelSetting = { callPoint: 'READING' | 'POST_PROCESS' | 'AFFILIATION'; providerId: string; model: string; thinking: boolean; source: string }
export type ThinkingStyle = 'DEEPSEEK' | 'ENABLE_THINKING' | 'NONE'
export type ModelProvider = { id: string; name: string; baseUrl: string; thinkingStyle: ThinkingStyle; keyHint: string; builtIn: boolean }
export type ProviderDraft = { name: string; baseUrl: string; apiKey: string; thinkingStyle: ThinkingStyle }
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
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: setting.providerId, model: setting.model, thinking: setting.thinking }),
})
export const resetModel = (point: ModelSetting['callPoint']) => request<void>(`/api/admin/models/${point}`, { method: 'DELETE' })
export async function probeModel(setting: ModelSetting): Promise<ProbeReport> {
  const res = await apiFetch(`/api/diagnostics/model?${new URLSearchParams({ provider: setting.providerId, model: setting.model, thinking: setting.thinking ? 'enabled' : 'disabled' })}`)
  if (!res.ok && res.status !== 502) throw new Error(await readError(res))
  return res.json() as Promise<ProbeReport>
}

const json = { 'Content-Type': 'application/json' }
export const getProviders = () => request<ModelProvider[]>('/api/admin/model-providers')
export const getProviderModels = (id: string) => request<string[]>(`/api/admin/model-providers/${encodeURIComponent(id)}/models`)
export const createProvider = (draft: ProviderDraft) => request<{ id: string }>('/api/admin/model-providers', { method: 'POST', headers: json, body: JSON.stringify(draft) })
export const updateProvider = (id: string, draft: ProviderDraft) => request<void>(`/api/admin/model-providers/${encodeURIComponent(id)}`, { method: 'PUT', headers: json, body: JSON.stringify(draft) })
export const deleteProvider = (id: string) => request<void>(`/api/admin/model-providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
