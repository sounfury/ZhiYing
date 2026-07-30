import { useEffect, useMemo, useRef, useState } from 'react'
import type { GraphData } from '../api'
import { factionColor } from '../factions'

export type PersonHit = {
  personId: string
  name: string
  /** 命中的别名（如果是靠别名匹配到的） */
  viaAlias?: string
  aliases: string[]
  importance: string
  appearanceCount: number
  factionName?: string
  factionColor?: string
  /** true = 被 min_appearance 过滤掉，当前不在图上 */
  filtered: boolean
}

interface PersonSearchProps {
  graph: GraphData | null
  onPick: (hit: PersonHit) => void
}

const MAX_HITS = 12

/** 命中等级：正名完全相等 > 正名前缀 > 正名包含 > 别名 > id */
function rank(
  q: string,
  name: string,
  aliases: string[],
  personId: string,
): { score: number; viaAlias?: string } | null {
  const n = name.toLowerCase()
  if (n === q) return { score: 0 }
  if (n.startsWith(q)) return { score: 1 }
  if (n.includes(q)) return { score: 2 }
  for (const a of aliases) {
    const al = a.toLowerCase()
    if (al === q) return { score: 3, viaAlias: a }
    if (al.includes(q)) return { score: 4, viaAlias: a }
  }
  if (personId.toLowerCase().includes(q)) return { score: 5 }
  return null
}

const IMPORTANCE_ORDER: Record<string, number> = {
  main: 0,
  supporting: 1,
  minor: 2,
}

/**
 * 人物模糊搜索：正名 / 别名 / person_id 都能命中。
 *
 * 结果里也带上被 min_appearance 过滤掉的路人（标「已过滤」），
 * 否则「搜不到某人」会让人以为是分析漏了，其实只是阈值挡住了。
 */
export function PersonSearch({ graph, onPick }: PersonSearchProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const hits = useMemo<PersonHit[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q || !graph) return []

    const factionOf = new Map(graph.factions.map((f) => [f.faction_id, f]))
    const scored: { hit: PersonHit; score: number }[] = []

    for (const n of graph.nodes) {
      const r = rank(q, n.name, n.aliases, n.person_id)
      if (!r) continue
      const f = n.primary_faction_id
        ? factionOf.get(n.primary_faction_id)
        : undefined
      scored.push({
        score: r.score,
        hit: {
          personId: n.person_id,
          name: n.name,
          viaAlias: r.viaAlias,
          aliases: n.aliases,
          importance: n.importance,
          appearanceCount: n.appearance_count,
          factionName: f?.name,
          factionColor: f ? factionColor(f) : undefined,
          filtered: false,
        },
      })
    }

    for (const p of graph.filtered_persons) {
      const r = rank(q, p.name, [], p.person_id)
      if (!r) continue
      scored.push({
        // 过滤掉的排在可见人物之后
        score: r.score + 10,
        hit: {
          personId: p.person_id,
          name: p.name,
          viaAlias: r.viaAlias,
          aliases: [],
          importance: 'minor',
          appearanceCount: 0,
          filtered: true,
        },
      })
    }

    scored.sort(
      (a, b) =>
        a.score - b.score ||
        (IMPORTANCE_ORDER[a.hit.importance] ?? 3) -
          (IMPORTANCE_ORDER[b.hit.importance] ?? 3) ||
        b.hit.appearanceCount - a.hit.appearanceCount ||
        a.hit.name.localeCompare(b.hit.name, 'zh'),
    )
    return scored.slice(0, MAX_HITS).map((s) => s.hit)
  }, [query, graph])

  // 结果变了就把高亮拉回第一条
  useEffect(() => setCursor(0), [query])

  const pick = (hit: PersonHit | undefined) => {
    if (!hit) return
    onPick(hit)
    setOpen(false)
    setQuery(hit.name)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (!hits.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setCursor((c) => (c + 1) % hits.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      setCursor((c) => (c - 1 + hits.length) % hits.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(hits[cursor])
    }
  }

  const total = graph?.nodes.length ?? 0

  return (
    <div className="person-search" ref={wrapRef}>
      <input
        type="search"
        value={query}
        placeholder={total ? `搜索人物（共 ${total} 人）` : '搜索人物'}
        disabled={!graph}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label="搜索人物"
      />

      {open && query.trim() && (
        <div className="person-search-pop">
          {!hits.length && <div className="person-search-empty">没找到匹配的人物</div>}
          {hits.map((h, i) => (
            <button
              type="button"
              key={h.personId}
              className={`person-search-row${i === cursor ? ' on' : ''}${
                h.filtered ? ' dim' : ''
              }`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(h)}
            >
              <i
                style={{ background: h.factionColor ?? '#cfc8c0' }}
                aria-hidden
              />
              <span className="ps-name">{h.name}</span>
              {h.viaAlias && <em className="ps-alias">别名 {h.viaAlias}</em>}
              {h.factionName && <em>{h.factionName}</em>}
              {h.filtered ? (
                <b className="ps-flag">已过滤</b>
              ) : (
                <b>{h.appearanceCount} 章</b>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
