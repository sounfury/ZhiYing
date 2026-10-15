/** 后台接口：用量聚合、各分析环节的服务商 / 模型 / 思考配置、模型服务商管理（密钥只写不读），以及按组的可调设置。 */
import { apiFetch, readError, request } from '../api'

/** 未配置时 providerId 为 null、model 为空串 */
export type ModelSetting = { callPoint: 'READING' | 'POST_PROCESS' | 'AFFILIATION'; providerId: string | null; model: string; thinking: boolean; configured: boolean }
export type ThinkingStyle = 'DEEPSEEK' | 'ENABLE_THINKING' | 'NONE'
export type ModelProvider = { id: string; name: string; baseUrl: string; thinkingStyle: ThinkingStyle; keyHint: string }
export type ProviderDraft = { name: string; baseUrl: string; apiKey: string; thinkingStyle: ThinkingStyle }
export type UsageDashboard = {
  daily: { date: string; tokens: number }[]
  limits: { maxBooks: number; maxAnalysisChars: number; maxFileBytes: number; maxConcurrentTasks: number; dailyTokenBudget: number; maxTokens: number }
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
export async function probeModel(setting: ModelSetting): Promise<ProbeReport> {
  const res = await apiFetch(`/api/diagnostics/model?${new URLSearchParams({ provider: setting.providerId ?? '', model: setting.model, thinking: setting.thinking ? 'enabled' : 'disabled' })}`)
  if (!res.ok && res.status !== 502) throw new Error(await readError(res))
  return res.json() as Promise<ProbeReport>
}

const json = { 'Content-Type': 'application/json' }
export const getProviders = () => request<ModelProvider[]>('/api/admin/model-providers')
export const getProviderModels = (id: string) => request<string[]>(`/api/admin/model-providers/${encodeURIComponent(id)}/models`)
export const createProvider = (draft: ProviderDraft) => request<{ id: string }>('/api/admin/model-providers', { method: 'POST', headers: json, body: JSON.stringify(draft) })
export const updateProvider = (id: string, draft: ProviderDraft) => request<void>(`/api/admin/model-providers/${encodeURIComponent(id)}`, { method: 'PUT', headers: json, body: JSON.stringify(draft) })
export const deleteProvider = (id: string) => request<void>(`/api/admin/model-providers/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** count：非负整数（min 缺省为 0），0 不限；bytes：字节数，max 为部署硬上限（0 不限）；prompt：系统提示词，参数写成 {{name}}，取值在 params 组同名条目 */
export type SettingType = 'count' | 'bytes' | 'prompt'
export type SettingItem = {
  key: string
  label: string
  type: SettingType
  value: number | string
  defaultValue: number | string
  overridden: boolean
  hint: string
  min?: number
  max?: number
  placeholders?: { name: string; description: string }[]
}
export type SettingGroup = { group: string; label: string; items: SettingItem[] }

const settingUrl = (group: string, key: string) => `/api/admin/settings/${encodeURIComponent(group)}/${encodeURIComponent(key)}`
export const getSettings = () => request<SettingGroup[]>('/api/admin/settings')
export const saveSetting = (group: string, key: string, value: number | string) => request<void>(settingUrl(group, key), { method: 'PUT', headers: json, body: JSON.stringify({ value }) })
export const resetSetting = (group: string, key: string) => request<void>(settingUrl(group, key), { method: 'DELETE' })
