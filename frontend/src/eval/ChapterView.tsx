/**
 * 单章核对详情：必有 / 可有 / 禁止关系与未标注记录各成一段，段首说明含义，列出全部条目（有问题的排前面）。
 */
import { useMemo, type ReactNode } from 'react'
import type { ChapterReport, ForbiddenCheck, RecordView, RelationCheck } from './evalApi'
import { RecordLine } from './parts'
import { TIER_LABEL, criteriaText, goldPair, isProblem, isSatisfied } from './report'

const REASON_LABEL: Record<string, string> = {
  PERSON_MISSING: '缺人物',
  NO_RECORD: '无记录',
  WITHHELD: '未准入',
  WRONG_TYPE: '类型不符',
}

/** 有问题的排前面，其余保持标注顺序 */
const problemsFirst = <T,>(items: T[], bad: (x: T) => boolean) => [...items.filter(bad), ...items.filter((x) => !bad(x))]

type Props = { chapter: ChapterReport; typeLabel: (id: string) => string }

export function ChapterView({ chapter: c, typeLabel }: Props) {
  const records = useMemo(() => new Map(c.records.map((r) => [r.id, r])), [c.records])
  const unlabeled = c.unlabeled.map((id) => records.get(id)).filter((r): r is RecordView => !!r)
  const requiredHits = c.required.filter((x) => x.hit).length
  const excused = c.required.filter((x) => x.excused).length
  const optionalHits = c.optional.filter((x) => x.hit).length
  const violations = c.forbidden.filter((f) => f.violated).length

  return (
    <div className="cv">
      <header className="cv-head">
        <h2>
          第 {c.number} 章 · {c.title}
        </h2>
        {c.actual_title && c.actual_title !== c.title && <span className="hint">导入后标题：{c.actual_title}</span>}
      </header>

      <Section
        title="必有关系"
        count={`找到 ${requiredHits} / ${c.required.length}${excused ? `，另 ${excused} 条不扣分` : ''}`}
        bad={c.required.some((x) => !isSatisfied(x))}
        help="标准要求必须找出的关系；在本章找到、类型可接受且已上图才算找到。按强 / 中 / 弱分档加权扣分；朋友这类弱关系漏掉只扣少量，两人本章已有强 / 中关系时不扣。"
      >
        {problemsFirst(c.required, isProblem).map((x, i) => (
          <CheckRow key={i} check={x} records={records} typeLabel={typeLabel} />
        ))}
      </Section>

      <Section
        title="可有关系"
        count={`找到 ${optionalHits} / ${c.optional.length}`}
        help="合理但偏弱或偏事件的关系；找到不算错，漏掉不扣分，只作参考。"
      >
        {c.optional.map((x, i) => (
          <CheckRow key={i} check={x} records={records} typeLabel={typeLabel} optional />
        ))}
      </Section>

      <Section
        title="禁止关系"
        count={c.forbidden.length ? `违反 ${violations} / ${c.forbidden.length}` : '无'}
        bad={violations > 0}
        help="标准认定在本章不成立的关系；结果里出现且已上图就算违反，计入「禁止关系避免」。"
      >
        {problemsFirst(c.forbidden, (f) => f.violated).map((f, i) => (
          <ForbiddenRow key={i} check={f} records={records} typeLabel={typeLabel} />
        ))}
      </Section>

      <Section
        title="未标注记录"
        count={`${unlabeled.length} 条`}
        help="结果里已上图、但标准完全没涉及这两人的关系；不计分，可据此判断是否该补进标准。"
      >
        {unlabeled.map((r) => (
          <li key={r.id} className="cv-item">
            <RecordLine record={r} />
          </li>
        ))}
      </Section>

      <details className="cv-all">
        <summary>本章全部记录 {c.records.length} 条（含未上图的）</summary>
        {c.records.map((r) => (
          <RecordLine key={r.id} record={r} />
        ))}
      </details>
    </div>
  )
}

function Section({
  title,
  count,
  help,
  bad,
  children,
}: {
  title: string
  count: string
  help: string
  bad?: boolean
  children: ReactNode[]
}) {
  return (
    <section className="cv-section">
      <h3>
        {title} <span className={bad ? 'cv-count bad' : 'cv-count'}>{count}</span>
      </h3>
      <p className="hint">{help}</p>
      {children.length > 0 ? <ul className="cv-list">{children}</ul> : <p className="cv-none hint">本章没有。</p>}
    </section>
  )
}

function CheckRow({
  check: x,
  records,
  typeLabel,
  optional,
}: {
  check: RelationCheck
  records: Map<string, RecordView>
  typeLabel: (id: string) => string
  optional?: boolean
}) {
  const g = x.gold
  const state = x.hit ? (x.direction_correct === false ? 'warn' : 'ok') : optional || x.excused ? 'muted' : x.tier === 'SOFT' ? 'warn' : 'err'
  const status = x.hit
    ? x.direction_correct === false
      ? '找到，但方向反了'
      : '找到'
    : `未找到 · ${x.excused ? '已有强 / 中关系，不扣分' : (REASON_LABEL[x.reason ?? ''] ?? '')}`
  const related = x.records.map((id) => records.get(id)).filter((r): r is RecordView => !!r)
  return (
    <li className={`cv-item ${state}`}>
      <div className="cv-line">
        <b>{goldPair(g)}</b>
        <span>标准：{g.label}</span>
        {x.tier && <span className={`rv-tag tier-${x.tier.toLowerCase()}`}>{TIER_LABEL[x.tier]}</span>}
        <span className={`rv-tag ${state}`}>{status}</span>
      </div>
      <div className="cv-kv">
        <span className="hint">可接受的类型</span>
        <span>{criteriaText(g.criteria, typeLabel)}</span>
      </div>
      {x.detail && (
        <div className="cv-kv">
          <span className="hint">{x.excused ? '不扣分原因' : '未找到原因'}</span>
          <span>{x.detail}</span>
        </div>
      )}
      {g.note && (
        <div className="cv-kv">
          <span className="hint">标注说明</span>
          <span>{g.note}</span>
        </div>
      )}
      {related.length > 0 && (
        <div className="cv-kv">
          <span className="hint">{x.hit ? '命中的记录' : '相关记录'}</span>
          <div>
            {related.map((r) => (
              <RecordLine key={r.id} record={r} />
            ))}
          </div>
        </div>
      )}
    </li>
  )
}

function ForbiddenRow({ check: f, records, typeLabel }: { check: ForbiddenCheck; records: Map<string, RecordView>; typeLabel: (id: string) => string }) {
  const related = f.records.map((id) => records.get(id)).filter((r): r is RecordView => !!r)
  return (
    <li className={`cv-item ${f.violated ? 'err' : 'ok'}`}>
      <div className="cv-line">
        <b>{goldPair(f.gold)}</b>
        <span>不应是：{criteriaText(f.gold.criteria, typeLabel)}</span>
        <span className={`rv-tag ${f.violated ? 'err' : 'ok'}`}>{f.violated ? '违反' : '未违反'}</span>
      </div>
      <div className="cv-kv">
        <span className="hint">理由</span>
        <span>{f.gold.reason}</span>
      </div>
      {related.length > 0 && (
        <div className="cv-kv">
          <span className="hint">违反的记录</span>
          <div>
            {related.map((r) => (
              <RecordLine key={r.id} record={r} />
            ))}
          </div>
        </div>
      )}
    </li>
  )
}
