/** 示例书固定链接及人物、章节定位参数；与页面状态共用章节阅读序号。 */
import type { BookMeta } from './api.ts'
import type { ChapterFocusState } from './types.ts'

export function readBookLink(search: string) {
  const params = new URLSearchParams(search)
  const chapter = Number(params.get('chapter'))
  const mode = params.get('chapter_mode') ?? 'upto'
  const chapterFocus: ChapterFocusState = Number.isSafeInteger(chapter) && chapter > 0 && (mode === 'single' || mode === 'upto')
    ? { mode, chapter }
    : { mode: 'all', chapter: 0 }
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
    url.searchParams.set('chapter', String(chapterFocus.chapter))
    url.searchParams.set('chapter_mode', chapterFocus.mode)
  }
  if (person) url.searchParams.set('focus', person)
  return url.toString()
}
