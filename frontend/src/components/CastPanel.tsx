import { useMemo, useState } from 'react'
import type { Cast, CastPerson, GraphData } from '../api'
import { GENDER_LABEL, IMPORTANCE_LABEL } from '../labels'

interface CastPanelProps {
  cast: Cast | null
  loading: boolean
  saving: boolean
  error: string
  graph: GraphData | null
  disabled: boolean
  onSavePerson: (person: CastPerson) => Promise<void>
  onMerge: (keepId: string, dropId: string) => Promise<void>
  onFocusPerson: (personId: string) => void
}

const IMPORTANCE_ORDER: Record<string, number> = {
  main: 0,
  supporting: 1,
  minor: 2,
}

function aliasText(p: CastPerson): string {
  return p.aliases.map((a) => a.name).join('、')
}

function parseAliases(text: string, previous: CastPerson['aliases']): CastPerson['aliases'] {
  const names = text
    .split(/[,，、;；]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return names.map((name) => {
    const prev = previous.find((a) => a.name === name)
    return prev ?? { name, frequency: 'low' }
  })
}

/**
 * 人名册：浏览、轻量编辑、合并疑似同人。不是巨型表单。
 */
export function CastPanel({
  cast,
  loading,
  saving,
  error,
  graph,
  disabled,
  onSavePerson,
  onMerge,
  onFocusPerson,
}: CastPanelProps) {
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<CastPerson | null>(null)
  const [aliasDraft, setAliasDraft] = useState('')
  const [mergeDrop, setMergeDrop] = useState('')
  const [confirmMerge, setConfirmMerge] = useState(false)

  const nameOf = (pid: string) =>
    cast?.persons.find((p) => p.person_id === pid)?.canonical_name ?? pid

  const inGraph = useMemo(() => {
    const ids = new Set(graph?.nodes.map((n) => n.person_id) ?? [])
    return ids
  }, [graph])

  const people = useMemo(() => {
    const list = [...(cast?.persons ?? [])]
    list.sort(
      (a, b) =>
        (IMPORTANCE_ORDER[a.importance] ?? 9) - (IMPORTANCE_ORDER[b.importance] ?? 9) ||
        a.canonical_name.localeCompare(b.canonical_name, 'zh'),
    )
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((p) => {
      if (p.canonical_name.toLowerCase().includes(q)) return true
      if (p.person_id.toLowerCase().includes(q)) return true
      return p.aliases.some((a) => a.name.toLowerCase().includes(q))
    })
  }, [cast, query])

  const startEdit = (p: CastPerson) => {
    setEditingId(p.person_id)
    setDraft({ ...p, aliases: [...p.aliases], merge_candidates: [...p.merge_candidates] })
    setAliasDraft(aliasText(p))
    setMergeDrop('')
    setConfirmMerge(false)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft(null)
    setAliasDraft('')
    setMergeDrop('')
    setConfirmMerge(false)
  }

  const save = async () => {
    if (!draft) return
    const person: CastPerson = {
      ...draft,
      aliases: parseAliases(aliasDraft, draft.aliases),
    }
    await onSavePerson(person)
    cancelEdit()
  }

  const doMerge = async (keepId: string, dropId: string) => {
    await onMerge(keepId, dropId)
    cancelEdit()
  }

  if (loading && !cast) {
    return <p className="hint">正在翻开人名册…</p>
  }

  if (!cast || !cast.persons.length) {
    return (
      <p className="hint">
        人名册还是空的。分析几章之后，人物会写在这里；也可以在条目里改正名、别名，或把同人合并。
      </p>
    )
  }

  return (
    <div className="cast-panel">
      <div className="cast-toolbar">
        <span className="cast-meta">
          {cast.persons.length} 人 · v{cast.version}
        </span>
        <input
          type="search"
          value={query}
          placeholder="检索人名、别名"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="检索人名册"
        />
      </div>

      {error && <p className="hint cast-error">{error}</p>}

      <ul className="cast-list">
        {people.map((p) => {
          const open = editingId === p.person_id
          return (
            <li key={p.person_id} className={`cast-row${open ? ' open' : ''}`}>
              <button
                type="button"
                className="cast-hit"
                onClick={() => (open ? cancelEdit() : startEdit(p))}
              >
                <span className="cast-name">{p.canonical_name}</span>
                <em>{IMPORTANCE_LABEL[p.importance] ?? p.importance}</em>
                {p.merge_candidates.length > 0 && (
                  <em className="warn">疑似 {p.merge_candidates.length}</em>
                )}
                {inGraph.has(p.person_id) ? (
                  <b>在图上</b>
                ) : (
                  <b className="dim">未入图</b>
                )}
              </button>

              {open && draft && (
                <div className="cast-editor">
                  <div className="cast-editor-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={!inGraph.has(p.person_id)}
                      onClick={() => onFocusPerson(p.person_id)}
                    >
                      在图上查看
                    </button>
                  </div>

                  <label>
                    正名
                    <input
                      value={draft.canonical_name}
                      disabled={disabled || saving}
                      onChange={(e) =>
                        setDraft({ ...draft, canonical_name: e.target.value })
                      }
                    />
                  </label>
                  <div className="cast-editor-row">
                    <label>
                      重要度
                      <select
                        value={draft.importance}
                        disabled={disabled || saving}
                        onChange={(e) =>
                          setDraft({ ...draft, importance: e.target.value })
                        }
                      >
                        <option value="main">主角</option>
                        <option value="supporting">配角</option>
                        <option value="minor">龙套</option>
                      </select>
                    </label>
                    <label>
                      性别
                      <select
                        value={draft.gender}
                        disabled={disabled || saving}
                        onChange={(e) => setDraft({ ...draft, gender: e.target.value })}
                      >
                        <option value="unknown">未知</option>
                        <option value="male">男</option>
                        <option value="female">女</option>
                      </select>
                    </label>
                  </div>
                  <label>
                    别名
                    <input
                      value={aliasDraft}
                      disabled={disabled || saving}
                      placeholder="顿号或逗号分隔"
                      onChange={(e) => setAliasDraft(e.target.value)}
                    />
                  </label>
                  <label>
                    简介
                    <textarea
                      rows={3}
                      value={draft.bio}
                      disabled={disabled || saving}
                      onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
                    />
                  </label>

                  <div className="cast-editor-actions">
                    <button
                      type="button"
                      className="btn primary"
                      disabled={disabled || saving || !draft.canonical_name.trim()}
                      onClick={() => void save()}
                    >
                      {saving ? '保存中…' : '保存'}
                    </button>
                    <button type="button" className="btn" onClick={cancelEdit}>
                      取消
                    </button>
                  </div>

                  {p.merge_candidates.length > 0 && (
                    <div className="cast-merge">
                      <span className="cast-merge-label">疑似同人</span>
                      {p.merge_candidates.map((cid) => (
                        <button
                          key={cid}
                          type="button"
                          className="btn"
                          disabled={disabled || saving}
                          onClick={() => void doMerge(p.person_id, cid)}
                          title={`将「${nameOf(cid)}」并入「${p.canonical_name}」`}
                        >
                          并入 {nameOf(cid)}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="cast-merge">
                    <span className="cast-merge-label">合并他人入此</span>
                    <select
                      value={mergeDrop}
                      disabled={disabled || saving}
                      onChange={(e) => {
                        setMergeDrop(e.target.value)
                        setConfirmMerge(false)
                      }}
                    >
                      <option value="">选择要并入的人…</option>
                      {cast.persons
                        .filter((o) => o.person_id !== p.person_id)
                        .map((o) => (
                          <option key={o.person_id} value={o.person_id}>
                            {o.canonical_name}
                            {GENDER_LABEL[o.gender] ? ` · ${GENDER_LABEL[o.gender]}` : ''}
                          </option>
                        ))}
                    </select>
                    {mergeDrop && !confirmMerge && (
                      <button
                        type="button"
                        className="btn danger"
                        onClick={() => setConfirmMerge(true)}
                      >
                        合并…
                      </button>
                    )}
                    {mergeDrop && confirmMerge && (
                      <p className="hint">
                        将「{nameOf(mergeDrop)}」并入「{p.canonical_name}」。账本里的
                        id 会改写，不可撤销。
                        <button
                          type="button"
                          className="btn danger"
                          disabled={disabled || saving}
                          onClick={() => void doMerge(p.person_id, mergeDrop)}
                        >
                          确认合并
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setConfirmMerge(false)}
                        >
                          再想想
                        </button>
                      </p>
                    )}
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {query.trim() && !people.length && <p className="hint">人名册里没有匹配的人。</p>}
    </div>
  )
}
