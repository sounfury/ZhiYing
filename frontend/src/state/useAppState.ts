import { useContext } from 'react'
import { AppStateContext, type AppStateValue } from './appStateContext'

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext)
  if (!ctx) throw new Error('useAppState 必须在 AppStateProvider 内使用')
  return ctx
}
