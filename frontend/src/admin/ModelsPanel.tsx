/** 管理员模型页签：编辑三个分析环节的模型与思考开关、恢复部署值、手动检查连接。 */
import { useEffect, useState, type FormEvent } from 'react'
import { getModels, probeModel, resetModel, saveModel, type ModelSetting, type ProbeReport } from './adminApi'

const LABELS = { READING: '读章', POST_PROCESS: '后处理', AFFILIATION: '团体归纳' }

export default function ModelsPanel() {
  const [models, setModels] = useState<ModelSetting[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void getModels().then((data) => { if (active) setModels(data) }).catch((e: unknown) => {
      if (active) setError(e instanceof Error ? e.message : String(e))
    })
    return () => { active = false }
  }, [])
  return <section className="admin-content" aria-label="模型配置">
    <h2>模型</h2>
    <p>修改后对之后启动的分析生效，正在运行的任务继续使用启动时的配置。更换模型或思考开关后，原配置的结果不能再秒传。</p>
    <p className="hint">模型名留空使用默认模型。服务地址与密钥由部署配置提供。</p>
    {error && <p className="account-error" role="alert">{error}</p>}
    {!models.length && !error && <p role="status">正在加载模型配置…</p>}
    {models.map((setting) => <ModelForm key={setting.callPoint} initial={setting} />)}
  </section>
}

function ModelForm({ initial }: { initial: ModelSetting }) {
  const [setting, setSetting] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [report, setReport] = useState<ProbeReport | null>(null)
  const act = async (action: 'save' | 'reset' | 'probe') => {
    setBusy(true); setError(''); setMessage(''); setReport(null)
    try {
      if (action === 'probe') {
        setReport(await probeModel(setting))
      } else {
        if (action === 'save') await saveModel(setting)
        else await resetModel(setting.callPoint)
        const current = (await getModels()).find((m) => m.callPoint === setting.callPoint)!
        setSetting(current)
        setMessage(action === 'save' ? '已保存，之后启动的分析使用此配置。' : '已恢复配置文件的值。')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); void act('save') }
  return <form className="account-form admin-model" onSubmit={submit}>
    <h3>{LABELS[setting.callPoint]} <span className="pill">{setting.source}</span></h3>
    <label>模型名<input value={setting.model} onChange={(e) => setSetting({ ...setting, model: e.target.value })} disabled={busy} /></label>
    <label>思考<select value={String(setting.thinking)} onChange={(e) => setSetting({ ...setting, thinking: e.target.value === 'true' })} disabled={busy}><option value="false">关闭</option><option value="true">开启</option></select></label>
    <div className="account-actions">
      <button type="submit" className="btn primary" disabled={busy}>保存</button>
      <button type="button" className="btn" disabled={busy} onClick={() => void act('reset')}>恢复配置文件</button>
      <button type="button" className="btn" disabled={busy} onClick={() => void act('probe')}>{busy ? '正在处理…' : '测试连接'}</button>
    </div>
    {error && <p className="account-error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {report && <div role="status"><p>模型 {report.model}：{report.passed ? '连接检查通过' : '连接检查失败'}</p><ul>{report.checks.map((check) => <li key={check.check}>{check.check}：{check.passed ? '通过' : '失败'} · {check.detail} · {check.elapsedMs} ms</li>)}</ul></div>}
  </form>
}
