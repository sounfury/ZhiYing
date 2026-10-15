/** 管理员模型页签：维护模型服务商；为三个分析环节选服务商、模型（下拉或手填）与思考开关并检查连接。没有内置服务商，未配置的环节不能启动分析。 */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  createProvider, deleteProvider, getModels, getProviderModels, getProviders, probeModel, saveModel, updateProvider,
  type ModelProvider, type ModelSetting, type ProbeReport, type ProviderDraft, type ThinkingStyle,
} from './adminApi'

const LABELS = { READING: '读章', POST_PROCESS: '后处理', AFFILIATION: '团体归纳' }
const STYLES: Record<ThinkingStyle, string> = { DEEPSEEK: 'DeepSeek（thinking.type）', ENABLE_THINKING: 'enable_thinking（通义、硅基流动等）', NONE: '不支持' }
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function ModelsPanel() {
  const [models, setModels] = useState<ModelSetting[]>([])
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [error, setError] = useState('')
  const loadProviders = useCallback(() => getProviders().then(setProviders), [])
  useEffect(() => {
    let active = true
    void Promise.all([getModels(), getProviders()]).then(([m, p]) => { if (active) { setModels(m); setProviders(p) } }).catch((e: unknown) => {
      if (active) setError(message(e))
    })
    return () => { active = false }
  }, [])
  return <section className="adm-page" aria-label="模型配置">
    <header className="adm-page-head"><div>
      <h2>模型</h2>
      <p className="hint">修改后对之后启动的分析生效，正在运行的任务继续使用启动时的配置。更换模型或思考开关后，原配置的结果不能再秒传；只换服务商、模型名不变时仍可秒传。任一环节未配置时不能启动分析。</p>
    </div></header>
    {error && <p className="adm-note err" role="alert">{error}</p>}
    {!models.length && !error && <p className="adm-empty" role="status">正在加载模型配置…</p>}
    {models.length > 0 && !providers.length && <p className="adm-note" role="status">还没有服务商，请先在下方新增服务商，再为各环节选择模型。</p>}
    {models.length > 0 && <div className="adm-grid">{models.map((setting) => <ModelForm key={setting.callPoint} initial={setting} providers={providers} />)}</div>}
    {models.length > 0 && <Providers providers={providers} onChange={loadProviders} />}
  </section>
}

function ModelForm({ initial, providers }: { initial: ModelSetting; providers: ModelProvider[] }) {
  const [saved, setSaved] = useState(initial)
  const [setting, setSetting] = useState(initial)
  const [options, setOptions] = useState<string[]>([])
  const [listNote, setListNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [report, setReport] = useState<ProbeReport | null>(null)
  useEffect(() => {
    let active = true
    setOptions([]); setListNote(setting.providerId ? '正在拉取模型列表…' : '')
    if (!setting.providerId) return
    getProviderModels(setting.providerId)
      .then((list) => { if (active) { setOptions(list); setListNote(list.length ? `可选 ${list.length} 个模型，也可手动填写` : '服务商未返回模型列表，请手动填写') } })
      .catch((e: unknown) => { if (active) setListNote(message(e)) })
    return () => { active = false }
  }, [setting.providerId])
  const dirty = setting.providerId !== saved.providerId || setting.model !== saved.model || setting.thinking !== saved.thinking
  const act = async (action: 'save' | 'probe') => {
    setBusy(true); setError(''); setNotice(''); setReport(null)
    try {
      if (action === 'probe') {
        setReport(await probeModel(setting))
      } else {
        await saveModel(setting)
        const current = (await getModels()).find((m) => m.callPoint === setting.callPoint)!
        setSetting(current); setSaved(current)
        setNotice('已保存，之后启动的分析使用此配置。')
      }
    } catch (e) {
      setError(message(e))
    } finally { setBusy(false) }
  }
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); void act('save') }
  const listId = `models-${setting.callPoint}`
  return <form className="adm-card adm-form" onSubmit={submit}>
    <div className="adm-card-head" style={{ marginBottom: 0 }}>
      <h3>{LABELS[setting.callPoint]}</h3>
      {dirty ? <span className="pill warn">未保存</span> : saved.configured ? <span className="pill">已配置</span> : <span className="pill warn">未配置</span>}
    </div>
    <label className="adm-field">服务商<select required value={setting.providerId ?? ''} onChange={(e) => setSetting({ ...setting, providerId: e.target.value, model: '' })} disabled={busy}>
      <option value="" disabled>请选择服务商</option>
      {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select></label>
    <label className="adm-field">模型<input list={listId} required value={setting.model} placeholder="从列表选择或手动填写" onChange={(e) => setSetting({ ...setting, model: e.target.value })} disabled={busy} />
      {listNote && <span className="hint">{listNote}</span>}
    </label>
    <datalist id={listId}>{options.map((m) => <option key={m} value={m} />)}</datalist>
    <label className="adm-switch"><input type="checkbox" checked={setting.thinking} onChange={(e) => setSetting({ ...setting, thinking: e.target.checked })} disabled={busy} />思考模式</label>
    <div className="adm-actions">
      <button type="submit" className="btn primary" disabled={busy || !dirty}>保存</button>
      <button type="button" className="btn" disabled={busy || !setting.providerId || !setting.model} onClick={() => void act('probe')}>测试连接</button>
    </div>
    {busy && <p className="hint" role="status" style={{ margin: 0 }}>正在处理…</p>}
    {error && <p className="adm-note err" role="alert">{error}</p>}
    {notice && <p className="adm-note" role="status">{notice}</p>}
    {report && <div className="adm-probe" role="status">
      <strong className={report.passed ? 'ok' : 'bad'}>{report.passed ? '✓ 连接检查通过' : '✗ 连接检查失败'}</strong> · {report.model}
      <ul>{report.checks.map((check) => <li key={check.check}>
        <span className={check.passed ? 'ok' : 'bad'}>{check.passed ? '✓' : '✗'}</span>
        <span>{check.check}{check.detail && <span className="hint"> · {check.detail}</span>}</span>
        <span className="hint">{check.elapsedMs} ms</span>
      </li>)}</ul>
    </div>}
  </form>
}

const EMPTY: ProviderDraft = { name: '', baseUrl: '', apiKey: '', thinkingStyle: 'NONE' }

/** 服务商表格与新增 / 编辑表单（editing：null 收起，'' 新增，其余为被编辑的 id）。 */
function Providers({ providers, onChange }: { providers: ModelProvider[]; onChange: () => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const close = () => { setEditing(null); setDraft(EMPTY); setError('') }
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await task(); await onChange(); close() } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  const edit = (p: ModelProvider) => { setEditing(p.id); setError(''); setDraft({ name: p.name, baseUrl: p.baseUrl, apiKey: '', thinkingStyle: p.thinkingStyle }) }
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    void run(() => (editing ? updateProvider(editing, draft) : createProvider(draft)))
  }
  const remove = (p: ModelProvider) => { if (window.confirm(`删除服务商「${p.name}」？`)) void run(() => deleteProvider(p.id)) }
  return <div className="adm-card">
    <div className="adm-card-head">
      <div><h3>服务商</h3><p className="hint">支持 OpenAI 兼容协议的服务。API Key 加密保存，保存后只显示末尾 4 位。</p></div>
      {editing === null && <button type="button" className="btn" onClick={() => setEditing('')}>＋ 新增服务商</button>}
    </div>
    {providers.length === 0 ? <p className="adm-empty">暂无服务商</p> : <div className="adm-table-wrap"><table className="adm-table">
      <thead><tr><th>名称</th><th>服务地址</th><th>密钥</th><th>思考参数</th><th /></tr></thead>
      <tbody>{providers.map((p) => <tr key={p.id}>
        <td>{p.name}</td>
        <td className="clip" title={p.baseUrl}><code>{p.baseUrl}</code></td>
        <td><code>…{p.keyHint}</code></td>
        <td>{STYLES[p.thinkingStyle]}</td>
        <td><div className="row-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={() => edit(p)}>编辑</button>
          <button type="button" className="btn ghost danger" disabled={busy} onClick={() => remove(p)}>删除</button>
        </div></td>
      </tr>)}</tbody>
    </table></div>}
    {editing === null && error && <p className="adm-note err" role="alert">{error}</p>}
    {editing !== null && <form className="adm-form" onSubmit={submit} style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--line)' }}>
      <h4 style={{ margin: 0 }}>{editing ? `编辑「${providers.find((p) => p.id === editing)?.name ?? ''}」` : '新增服务商'}</h4>
      <div className="adm-form cols">
        <label className="adm-field">名称<input required maxLength={40} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} disabled={busy} /></label>
        <label className="adm-field">服务地址<input required type="url" placeholder="https://api.example.com/v1" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} disabled={busy} /></label>
        <label className="adm-field">API Key<input type="password" autoComplete="off" required={!editing} placeholder={editing ? '留空保留原密钥' : ''} value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} disabled={busy} /></label>
        <label className="adm-field">思考参数<select value={draft.thinkingStyle} onChange={(e) => setDraft({ ...draft, thinkingStyle: e.target.value as ThinkingStyle })} disabled={busy}>
          {(Object.keys(STYLES) as ThinkingStyle[]).map((s) => <option key={s} value={s}>{STYLES[s]}</option>)}
        </select></label>
      </div>
      {error && <p className="adm-note err" role="alert">{error}</p>}
      <div className="adm-actions">
        <button type="submit" className="btn primary" disabled={busy}>{editing ? '保存' : '新增'}</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={close}>取消</button>
      </div>
    </form>}
  </div>
}
