/**
 * 侧栏「人物」页签：
 * - 未选中：本书概览（书名、作者、人物 / 关系 / 势力数，耗时与用量）+ 出场最多的人物；
 * - 选中人物：人物卡（标签、全书简介或单章里的事件、出场章节条、以此人为中心、按硬 / 中 / 软分组的关系与依据）；
 * - 选中连线：两人之间每条关系的类型、硬度、章节与引文。
 * 单章模式不显示全书简介（PRD §5.7.1），证据展示遵循 PRD §5.6。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  getAnalysisTask,
  type AnalysisTaskSnapshot,
  type BookMeta,
  type ChapterBrief,
  type ChapterLedger,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  type GraphTag,
} from '../api'
import { UNASSIGNED_FACTION_ID } from '../factions'
import { GENDER_LABEL, IMPORTANCE_LABEL, formatTokens, shortTitle } from '../labels'
import { Avatar, HardnessSymbol, PersonRow } from './PersonParts'
import {
  HARDNESS_LABEL,
  HARDNESS_ORDER,
  byAppearance,
  chapterShort,
  hardnessOf,
  nodeColor,
  shortName,
} from './personUtils'

interface DetailPanelProps {
  graph: GraphData | null
  book: BookMeta | undefined
  /** 人名册总人数（概览用）；未加载时按图上人数 + 被过滤人数估算 */
  castCount: number | undefined
  chapters: ChapterBrief[]
  chapterLabel: (id: number | undefined) => string
  selectedNode: GraphNode | null
  selectedEdge: GraphEdge | null
  egoPersonId: string | null
  /** 单章聚焦时的本章结果（列本章与此人相关的事件 / 关系依据） */
  focusLedger: ChapterLedger | null
  focusLedgerLoading: boolean
  onSetEgo: (personId: string | null) => void
  /** 选中并在图上聚焦某人 */
  onFocusPerson: (personId: string) => void
  /** 切到单章模式的某章 */
  onJumpChapter: (chapterId: number) => void
  /** 改为查看某条连线（两人之间的全部关系） */
  onSelectEdge: (edge: GraphEdge) => void
}

export function DetailPanel(props: DetailPanelProps) {
  const { selectedNode, selectedEdge } = props
  if (selectedNode) return <PersonCard key={selectedNode.person_id} node={selectedNode} {...props} />
  if (selectedEdge) return <EdgeCard key={`${selectedEdge.person_a}|${selectedEdge.person_b}`} edge={selectedEdge} {...props} />
  return <BookOverview {...props} />
}

/* ── 公共小函数 ── */

/** 章节列表文字：多于 3 章时只列前两章再加「等 N 章」 */
function chapterList(ids: number[], label: (id: number) => string): string {
  if (ids.length <= 3) return ids.map(label).join('、')
  return `${ids.slice(0, 2).map(label).join('、')} 等 ${ids.length} 章`
}

/** 关系行里显示的称谓：有向关系显示对方在关系中的角色（如对方是「父亲」），否则显示关系类型 */
function roleOfOther(tag: GraphTag, otherId: string): string {
  if (!tag.directed || !tag.source_person_id) return tag.label
  const role = otherId === tag.source_person_id ? tag.subject_role : tag.object_role
  return role || tag.label
}

function Evidences({ tag, chapterLabel }: { tag: GraphTag; chapterLabel: (id: number) => string }) {
  if (!tag.evidences.length) {
    return <div className="ev-note">{tag.raw_relations[0] || '暂无可展示的依据'}</div>
  }
  return (
    <>
      {tag.evidences.map((ev, i) => {
        const note = ev.note && ev.note !== ev.quote ? ev.note : ''
        return (
          <div key={i} className="ev-item">
            {ev.quote && <p className="ev-quote">「{ev.quote}」</p>}
            <div className="ev-note">
              {chapterLabel(ev.chapter_id)}
              {note && ` · ${note}`}
            </div>
          </div>
        )
      })}
    </>
  )
}

/* ── 本书概览 ── */

function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function BookOverview({ graph, book, castCount, chapters, onFocusPerson }: DetailPanelProps) {
  const [task, setTask] = useState<AnalysisTaskSnapshot | null>(null)
  const bookId = book?.book_id
  const status = book?.status
  const totalTokens = book?.token_usage?.total_tokens
  useEffect(() => {
    if (!bookId) return
    let cancelled = false
    getAnalysisTask(bookId)
      .then((t) => {
        if (!cancelled) setTask(t)
      })
      .catch(() => {
        if (!cancelled) setTask(null)
      })
    return () => {
      cancelled = true
    }
  }, [bookId, status, totalTokens])

  const top = useMemo(() => [...(graph?.nodes ?? [])].sort(byAppearance).slice(0, 5), [graph])
  if (!book) return <p className="side-empty">正在读取书目信息…</p>

  const people = castCount ?? (graph ? graph.nodes.length + graph.filtered_count : undefined)
  const relationRecords = task?.message?.match(/关系记录\s*(\d+)/)?.[1]
  const graphRelations = graph?.edges.reduce((n, e) => n + e.tags.length, 0)
  const factions = graph?.factions.filter((f) => f.faction_id !== UNASSIGNED_FACTION_ID).length
  const elapsed =
    task?.started_at && task.finished_at && !task.active
      ? Date.parse(task.finished_at) - Date.parse(task.started_at)
      : NaN
  const usage = book.token_usage

  const counts: [string, string][] = []
  if (people != null) counts.push([String(people), '人物'])
  if (relationRecords) counts.push([relationRecords, '关系记录'])
  else if (graphRelations != null) counts.push([String(graphRelations), '图上关系'])
  if (factions != null) counts.push([String(factions), '势力'])
  const costs: [string, string][] = []
  if (Number.isFinite(elapsed) && elapsed > 0) {
    costs.push([formatElapsed(elapsed), task?.kind && task.kind !== 'full' ? '上次重读耗时' : '分析耗时'])
  }
  if (usage?.llm_requests) costs.push([String(usage.llm_requests), '模型请求'])
  if (usage?.total_tokens) costs.push([formatTokens(usage.total_tokens).replace(' ', ''), 'token'])

  const single = graph?.chapter_focus?.mode === 'single'

  return (
    <div className="detail-panel">
      <div className="card">
        <h2 className="book-title">{shortTitle(book.title)}</h2>
        {book.author && <div className="book-author">{book.author}</div>}
        {counts.length > 0 && <StatGrid items={counts} />}
        {costs.length > 0 && (
          <StatGrid
            items={costs}
            title={
              usage
                ? `累计输入 ${formatTokens(usage.input_tokens)} · 输出 ${formatTokens(usage.output_tokens)}（整书分析与单章重跑合计）`
                : undefined
            }
          />
        )}
      </div>
      {top.length > 0 && (
        <section className="sec">
          <h3>出场最多</h3>
          <div className="person-list">
            {top.map((n) => (
              <PersonRow key={n.person_id} node={n} graph={graph} chapters={chapters} hideBio={single} onPick={onFocusPerson} />
            ))}
          </div>
        </section>
      )}
      <p className="side-note center">点图上的人物或连线查看详情</p>
    </div>
  )
}

function StatGrid({ items, title }: { items: [string, string][]; title?: string }) {
  return (
    <div className="stat" title={title}>
      {items.map(([value, label]) => (
        <div key={label}>
          <b>{value}</b>
          <span>{label}</span>
        </div>
      ))}
    </div>
  )
}

/* ── 人物卡 ── */

type RelItem = {
  key: string
  edge: GraphEdge
  tag: GraphTag
  otherId: string
  other: GraphNode | undefined
}

function PersonCard({
  node,
  graph,
  chapters,
  chapterLabel,
  egoPersonId,
  focusLedger,
  focusLedgerLoading,
  onSetEgo,
  onFocusPerson,
  onJumpChapter,
  onSelectEdge,
}: DetailPanelProps & { node: GraphNode }) {
  const [openRel, setOpenRel] = useState<string | null>(null)
  const focus = graph?.chapter_focus ?? null
  const singleChapter = focus?.mode === 'single' ? focus.chapter : null
  const short = shortName(node.name)
  const color = nodeColor(graph, node)
  const faction = graph?.factions.find((f) => f.faction_id === node.primary_faction_id)
  const label = (id: number) => chapterLabel(id)

  const rels = useMemo(() => {
    const byId = new Map((graph?.nodes ?? []).map((n) => [n.person_id, n]))
    const out: RelItem[] = []
    for (const e of graph?.edges ?? []) {
      if (e.person_a !== node.person_id && e.person_b !== node.person_id) continue
      const otherId = e.person_a === node.person_id ? e.person_b : e.person_a
      for (const tag of e.tags) {
        out.push({ key: `${otherId}|${tag.key}`, edge: e, tag, otherId, other: byId.get(otherId) })
      }
    }
    return out.sort(
      (x, y) =>
        Number(Boolean(y.tag.in_focus_chapter)) - Number(Boolean(x.tag.in_focus_chapter)) ||
        y.tag.display_score - x.tag.display_score,
    )
  }, [graph, node.person_id])

  const chips: { text: string; key?: boolean }[] = []
  if (IMPORTANCE_LABEL[node.importance]) chips.push({ text: IMPORTANCE_LABEL[node.importance], key: true })
  if (node.gender === 'male' || node.gender === 'female') chips.push({ text: GENDER_LABEL[node.gender] })
  if (faction && faction.faction_id !== UNASSIGNED_FACTION_ID) chips.push({ text: faction.name })
  for (const alias of node.aliases.filter((a) => a !== node.name).slice(0, 3)) chips.push({ text: `又称 ${alias}` })

  return (
    <div className="detail-panel">
      <div className="card">
        <div className="who">
          <Avatar name={node.name} color={color} />
          <div className="who-text">
            <h2>{node.name}</h2>
            <div className="chips">
              {chips.map((c) => (
                <span key={c.text} className={`chip${c.key ? ' k' : ''}`}>
                  {c.text}
                </span>
              ))}
            </div>
          </div>
        </div>

        {singleChapter != null ? (
          <ChapterNotes
            node={node}
            chapterTitle={chapterLabel(singleChapter)}
            ledger={focusLedger?.chapter_id === singleChapter ? focusLedger : null}
            loading={focusLedgerLoading}
          />
        ) : (
          <section className="sec">
            <h3>全书简介</h3>
            <p className={`bio${node.bio ? '' : ' muted'}`}>{node.bio || '（路人，暂无简介）'}</p>
          </section>
        )}

        <AppearanceStrip
          node={node}
          chapters={chapters}
          current={focus ? focus.chapter : null}
          onJump={onJumpChapter}
        />

        <section className="sec">
          {egoPersonId === node.person_id ? (
            <button type="button" className="btn wide" onClick={() => onSetEgo(null)}>
              回到全图 <kbd>Esc</kbd>
            </button>
          ) : (
            <button type="button" className="btn wide" onClick={() => onSetEgo(node.person_id)}>
              以{short}为中心查看 <kbd>双击</kbd>
            </button>
          )}
        </section>
      </div>

      {rels.length === 0 ? (
        <p className="side-empty">当前范围内没有关系</p>
      ) : (
        HARDNESS_ORDER.map((h) => {
          const group = rels.filter((r) => hardnessOf(r.tag) === h)
          if (!group.length) return null
          return (
            <section key={h} className="sec">
              <h3>
                <HardnessSymbol hardness={h} />
                {HARDNESS_LABEL[h]}关系 <span>{group.length}</span>
              </h3>
              {group.map((r) => (
                <RelRow
                  key={r.key}
                  item={r}
                  open={openRel === r.key}
                  showNow={singleChapter != null}
                  chapterLabel={label}
                  onToggle={() => setOpenRel((cur) => (cur === r.key ? null : r.key))}
                  onPickOther={() => onFocusPerson(r.otherId)}
                  onOpenEdge={() => onSelectEdge(r.edge)}
                />
              ))}
            </section>
          )
        })
      )}
    </div>
  )
}

/** 单章模式下替代全书简介：本章里与此人相关的关系依据与事件 */
const NOTES_PREVIEW = 5

function ChapterNotes({
  node,
  chapterTitle,
  ledger,
  loading,
}: {
  node: GraphNode
  chapterTitle: string
  ledger: ChapterLedger | null
  loading: boolean
}) {
  const [showAll, setShowAll] = useState(false)
  const notes = useMemo(() => {
    if (!ledger) return []
    const id = node.person_id
    const texts = [
      ...ledger.relations
        .filter((r) => r.status !== 'rejected' && (r.person_a === id || r.person_b === id))
        .map((r) => r.evidence.note || r.raw_relation),
      ...ledger.events.filter((ev) => ev.persons.includes(id)).map((ev) => ev.description),
    ]
    return [...new Set(texts.map((t) => t.trim()).filter(Boolean))]
  }, [ledger, node.person_id])
  const shown = showAll ? notes : notes.slice(0, NOTES_PREVIEW)

  return (
    <section className="sec">
      <h3>
        {chapterTitle}里的{shortName(node.name)}
      </h3>
      {loading && !ledger ? (
        <p className="bio muted">正在取本章结果…</p>
      ) : notes.length ? (
        <ul className="chapter-notes">
          {shown.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : (
        <p className="bio muted">本章有出场，没有记录到与他人的关系或事件。</p>
      )}
      {notes.length > NOTES_PREVIEW && (
        <button type="button" className="text-link" onClick={() => setShowAll((v) => !v)}>
          {showAll ? '收起' : `还有 ${notes.length - NOTES_PREVIEW} 条`}
        </button>
      )}
      <p className="bio-foot">单章模式不显示全书简介，避免提前看到后文</p>
    </section>
  )
}

/** 出场章节条：逐章一格；章节多时改成可横向滚动的细条 */
const COMPACT_OVER = 12

function AppearanceStrip({
  node,
  chapters,
  current,
  onJump,
}: {
  node: GraphNode
  chapters: ChapterBrief[]
  current: number | null
  onJump: (chapterId: number) => void
}) {
  const appeared = new Set(node.chapter_ids ?? [])
  if (!chapters.length) return null
  const compact = chapters.length > COMPACT_OVER
  const count = chapters.filter((c) => appeared.has(c.chapter_id)).length
  return (
    <section className="sec">
      <h3>
        出场章节{' '}
        <span>
          {count} / {chapters.length} · 点击跳到该章
        </span>
      </h3>
      <div
        className={`strip${compact ? ' compact' : ''}`}
        style={compact ? undefined : { gridTemplateColumns: `repeat(${Math.min(chapters.length, 6)}, 1fr)` }}
      >
        {chapters.map((c, i) => {
          const on = appeared.has(c.chapter_id)
          return (
            <button
              key={c.chapter_id}
              type="button"
              className={`${on ? 'on' : ''}${current === c.chapter_id ? ' cur' : ''}`}
              disabled={!on}
              title={`${c.title || `第 ${i + 1} 章`}${on ? '' : ' · 未出场'}`}
              onClick={() => onJump(c.chapter_id)}
            >
              <i />
              {!compact && chapterShort(c, i)}
            </button>
          )
        })}
      </div>
      {compact && (
        <div className="strip-axis">
          <span>{chapterShort(chapters[0], 0)}</span>
          <span>{chapterShort(chapters[chapters.length - 1], chapters.length - 1)}</span>
        </div>
      )}
    </section>
  )
}

function RelRow({
  item,
  open,
  showNow,
  chapterLabel,
  onToggle,
  onPickOther,
  onOpenEdge,
}: {
  item: RelItem
  open: boolean
  showNow: boolean
  chapterLabel: (id: number) => string
  onToggle: () => void
  onPickOther: () => void
  onOpenEdge: () => void
}) {
  const { tag, other, otherId } = item
  const name = other?.name ?? otherId
  return (
    <div className={`rel${open ? ' open' : ''}`}>
      <div
        className="rel-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={`${tag.label}（${tag.category}）· 点击查看依据`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        <span className="typ">{roleOfOther(tag, otherId)}</span>
        <button
          type="button"
          className="oth"
          title={`查看${name}`}
          onClick={(e) => {
            e.stopPropagation()
            onPickOther()
          }}
        >
          {name}
        </button>
        {showNow && tag.in_focus_chapter && <span className="tag-now">本章</span>}
        <span className="chs">{chapterList(tag.chapter_ids, chapterLabel)}</span>
      </div>
      {open && (
        <div className="ev">
          <Evidences tag={tag} chapterLabel={chapterLabel} />
          {item.edge.tags.length > 1 && (
            <button type="button" className="text-link ev-more" onClick={onOpenEdge}>
              看两人之间的全部 {item.edge.tags.length} 种关系
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* ── 连线详情 ── */

function EdgeCard({ edge, graph, chapterLabel, onFocusPerson }: DetailPanelProps & { edge: GraphEdge }) {
  const byId = new Map((graph?.nodes ?? []).map((n) => [n.person_id, n]))
  const a = byId.get(edge.person_a)
  const b = byId.get(edge.person_b)
  const nameOf = (id: string) => byId.get(id)?.name ?? id
  const single = graph?.chapter_focus?.mode === 'single'
  const label = (id: number) => chapterLabel(id)
  const tags = [...edge.tags].sort(
    (x, y) => HARDNESS_ORDER.indexOf(hardnessOf(x)) - HARDNESS_ORDER.indexOf(hardnessOf(y)) || y.display_score - x.display_score,
  )

  return (
    <div className="detail-panel">
      <div className="card">
        <div className="who">
          {a && <Avatar name={a.name} color={nodeColor(graph, a)} />}
          <span className="pair-arrow" aria-hidden="true">
            ⇄
          </span>
          {b && <Avatar name={b.name} color={nodeColor(graph, b)} />}
        </div>
        <h2 className="pair-title">
          <button type="button" className="name-link" onClick={() => onFocusPerson(edge.person_a)}>
            {nameOf(edge.person_a)}
          </button>
          <span> 与 </span>
          <button type="button" className="name-link" onClick={() => onFocusPerson(edge.person_b)}>
            {nameOf(edge.person_b)}
          </button>
        </h2>
        {tags.map((t) => {
          const h = hardnessOf(t)
          const target = t.source_person_id === edge.person_a ? edge.person_b : edge.person_a
          return (
            <section key={t.key} className="sec">
              <h3>
                <HardnessSymbol hardness={h} />
                {t.label} · {HARDNESS_LABEL[h]}关系 <span>{chapterList(t.chapter_ids, label)}</span>
                {single && (t.in_focus_chapter ? <span className="tag-now">本章</span> : <span className="tag-past">更早</span>)}
              </h3>
              {t.directed && t.source_person_id && t.subject_role && (
                <p className="role-line">
                  {nameOf(t.source_person_id)}（{t.subject_role}）→ {nameOf(target)}（{t.object_role}）
                </p>
              )}
              <Evidences tag={t} chapterLabel={label} />
            </section>
          )
        })}
      </div>
    </div>
  )
}
