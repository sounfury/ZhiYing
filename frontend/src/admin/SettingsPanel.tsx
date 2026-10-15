/** 管理员设置页签：按组列出后台可调项（用量上限、各步骤提示词及其参数），显示当前值与是否改过，可保存或恢复默认；提示词参数就地显示在用到它的提示词下。 */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { getSettings, resetSetting, saveSetting, type SettingGroup, type SettingItem } from './adminApi'

const MIB = 1024 * 1024
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** 编辑框里的文字：字节按 MiB 显示，其余原样 */
const toText = (item: SettingItem, v: number | string) => (item.type === 'bytes' ? String(Math.round((Number(v) / MIB) * 100) / 100) : String(v))
const fromText = (item: SettingItem, text: string): number | string =>
  item.type === 'prompt' ? text : item.type === 'bytes' ? Math.round(Number(text) * MIB) : Number(text)

export default function SettingsPanel() {
  const [groups, setGroups] = useState<SettingGroup[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => getSettings().then(setGroups).catch((e: unknown) => setError(message(e))), [])
  useEffect(() => { void load() }, [load])
  const params = groups?.find((g) => g.group === 'params')?.items ?? []
  return <section className="adm-page" aria-label="设置">
    <header className="adm-page-head"><div>
      <h2>设置</h2>
      <p className="hint">保存后对之后的上传与启动的分析生效，不用重启；正在运行的任务继续使用启动时的提示词。改过提示词后原结果不能再秒传，继续分析时用旧提示词读的章会重读。</p>
    </div></header>
    {error && <p className="adm-note err" role="alert">{error}</p>}
    {!groups && !error && <p className="adm-empty" role="status">正在加载设置…</p>}
    {groups?.filter((g) => g.group !== 'params').map((g) => <div className="adm-card" key={g.group}>
      <div className="adm-card-head"><h3>{g.label}</h3></div>
      <div className={g.items.some((i) => i.type === 'prompt') ? 'adm-form' : 'adm-form cols'}>
        {g.items.map((item) => <SettingField key={`${item.key}:${String(item.value)}:${item.overridden}`} group={g.group} item={item} params={params} onSaved={load} />)}
      </div>
    </div>)}
  </section>
}

function SettingField({ group, item, params = [], onSaved }: { group: string; item: SettingItem; params?: SettingItem[]; onSaved: () => Promise<void> }) {
  const [text, setText] = useState(toText(item, item.value))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dirty = text !== toText(item, item.value)
  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await task(); await onSaved() } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); void run(() => saveSetting(group, item.key, fromText(item, text))) }
  const pill = dirty ? <span className="pill warn">未保存</span> : item.overridden ? <span className="pill">已修改</span> : <span className="pill" title="使用默认值">默认</span>
  const actions = <div className="adm-actions">
    <button type="submit" className="btn primary" disabled={busy || !dirty}>保存</button>
    <button type="button" className="btn ghost" disabled={busy || !item.overridden} onClick={() => void run(() => resetSetting(group, item.key))}>恢复默认</button>
    {busy && <span className="hint" role="status">正在处理…</span>}
  </div>
  const err = error && <p className="adm-note err" role="alert">{error}</p>

  if (item.type === 'prompt') {
    const used = params.filter((p) => item.placeholders?.some((h) => h.name === p.key))
    return <details className="adm-prompt">
      <summary><span>{item.label}</span>{pill}</summary>
      {item.hint && <p className="hint">{item.hint}</p>}
      {!!item.placeholders?.length && <p className="hint">可用参数（运行时替换为下面填的值）：{item.placeholders.map((p) => <span key={p.name}><code>{`{{${p.name}}}`}</code> {p.description}　</span>)}</p>}
      {!!used.length && <div className="adm-form cols adm-prompt-params">
        {used.map((p) => <SettingField key={`${p.key}:${String(p.value)}:${p.overridden}`} group="params" item={p} onSaved={onSaved} />)}
      </div>}
      <form className="adm-form" onSubmit={submit}>
        <textarea aria-label={item.label} value={text} rows={18} spellCheck={false} onChange={(e) => setText(e.target.value)} disabled={busy} />
        {err}
        {actions}
      </form>
    </details>
  }

  const unit = item.type === 'bytes' ? 'MiB' : ''
  const hint = item.type !== 'bytes' ? item.hint : item.max ? `不超过部署上限 ${toText(item, item.max)} MiB` : '0 表示不限'
  return <form className="adm-form" onSubmit={submit}>
    <label className="adm-field">
      <span className="adm-field-head">{item.label}{unit && `（${unit}）`}{pill}</span>
      <input type="number" min={item.min ?? 0} step={item.type === 'bytes' ? 0.01 : 1} max={item.type === 'bytes' && item.max ? item.max / MIB : undefined} required value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
      <span className="hint">{hint}</span>
    </label>
    {err}
    {actions}
  </form>
}
