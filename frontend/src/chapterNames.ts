/** 正文章节的显示名工具：「第一章」式中文序号、较短的原标题优先，章节条刻度与范围说明共用。 */
import type { ChapterBrief } from './api'

const DIGITS = '零一二三四五六七八九'

/** 1…999 → 中文数字（十一、二十、一百零五） */
export function cnNumber(n: number): string {
  if (n <= 0 || n >= 1000 || !Number.isInteger(n)) return String(n)
  const h = Math.floor(n / 100)
  const t = Math.floor((n % 100) / 10)
  const d = n % 10
  let s = ''
  if (h) s += DIGITS[h] + '百'
  if (t) s += (t === 1 && !h ? '' : DIGITS[t]) + '十'
  else if (h && d) s += '零'
  if (d) s += DIGITS[d]
  return s
}

const MAX_TITLE = 6

/**
 * 各章短名：所有正文标题都短（≤ 6 字、非「未知」）就用原标题，否则统一用「第 N 章」序号，
 * 避免一半标题一半序号混排。
 */
export function chapterShortNames(chapters: ChapterBrief[]): string[] {
  const titles = chapters.map((c) => (c.title ?? '').trim())
  const usable = titles.every((t) => t && t !== '未知' && [...t].length <= MAX_TITLE)
  return usable ? titles : chapters.map((_, i) => `第${cnNumber(i + 1)}章`)
}

/** 某章（chapter_id）的短名；不在正文里时退回原标题 */
export function chapterShortName(chapters: ChapterBrief[], chapterId: number): string {
  const i = chapters.findIndex((c) => c.chapter_id === chapterId)
  if (i < 0) return `第 ${chapterId} 段`
  return chapterShortNames(chapters)[i]
}

/** 字数：不足一万写「8,520 字」，否则「2.7 万字」 */
export function formatWords(n: number): string {
  if (!n) return '0 字'
  return n < 10000 ? `${n.toLocaleString()} 字` : `${(n / 10000).toFixed(1)} 万字`
}
