/** 主题偏好（跟随系统 / 浅 / 深）：写到 <html data-theme>，记在 localStorage；index.html 里有同 key 的首帧脚本。 */
import { useCallback, useEffect, useState } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'zhiying.theme'

export const THEME_LABEL: Record<ThemePref, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}

const NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' }

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

function applyPref(pref: ThemePref) {
  const root = document.documentElement
  if (pref === 'system') delete root.dataset.theme
  else root.dataset.theme = pref
}

/** 当前主题偏好与「切到下一档」动作。 */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref)

  useEffect(() => {
    applyPref(pref)
    try {
      if (pref === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, pref)
    } catch {
      /* 隐私模式等无法写 localStorage 时只在本次会话生效 */
    }
  }, [pref])

  const cycle = useCallback(() => setPref((p) => NEXT[p]), [])
  return { pref, cycle }
}
