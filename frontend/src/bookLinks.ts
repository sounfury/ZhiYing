/** 示例书固定链接及人物、章节定位参数；与页面状态共用章节阅读序号。 */
import { chapterFocusParams, type BookMeta } from './api.ts'
import type { ChapterFocusState } from './types.ts'

export function readBookLink(search: string) {
  const params = new URLSearchParams(search)
  const mode = params.get('chapter_mode')
  const chapter = Number(params.get('chapter'))
  // 旧链接的 upto:N 即第 1～N 章
  const [from, to] = mode === 'single' ? [chapter, chapter] : mode === 'upto' ? [1, chapter] : [Number(params.get('chapter_from')), Number(params.get('chapter_to'))]
  const valid = [from, to].every((n) => Number.isSafeInteger(n) && n > 0) && from <= to
  const chapterFocus: ChapterFocusState = valid ? { mode: mode === 'single' ? 'single' : 'range', from, to } : { mode: 'all', from: 0, to: 0 }
  return {
    example: params.get('example') ?? '',
    book: params.get('book') ?? '',
    person: params.get('focus')?.trim() ?? '',
    chapterFocus,
  }
}

export function bookLink(base: string, book: Pick<BookMeta, 'book_id' | 'example_slug'>, chapterFocus: ChapterFocusState, person: string | null): string {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Error('无法生成链接：页面地址无效')
  }
  url.search = ''
  url.hash = ''
  url.searchParams.set(book.example_slug ? 'example' : 'book', book.example_slug || book.book_id)
  if (chapterFocus.mode !== 'all') {
    for (const [k, v] of Object.entries(chapterFocusParams({ ...chapterFocus, mode: chapterFocus.mode }))) url.searchParams.set(k, v)
  }
  if (person) url.searchParams.set('focus', person)
  return url.toString()
}
