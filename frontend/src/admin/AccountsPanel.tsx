/** 管理员账号页签：生成并查看邀请码，为指定用户重置密码。 */
import { useEffect, useState, type FormEvent } from 'react'
import { createInvitation, listInvitations, listUsers, resetPassword, type Invitation, type User } from '../authApi'
import { useAuth } from '../useAuth'

export default function AccountsPanel() {
  const { user, refresh } = useAuth()
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loaded, setLoaded] = useState(false)
  const [maxUses, setMaxUses] = useState('1')
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [copied, setCopied] = useState('')

  useEffect(() => {
    let cancelled = false
    void Promise.all([listInvitations(), listUsers()]).then(([codes, accounts]) => {
      if (cancelled) return
      setInvitations(codes.invitations)
      setUsers(accounts.users)
      setUserId(accounts.users[0]?.id ?? '')
      setLoaded(true)
    }).catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e))
    })
    return () => { cancelled = true }
  }, [])

  const onCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const uses = Number(maxUses)
    if (!Number.isSafeInteger(uses) || uses < 1 || uses > 2147483647) {
      setError('可用次数必须为 1–2147483647 的整数')
      return
    }
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const invitation = await createInvitation(uses)
      setInvitations((prev) => [invitation, ...prev])
      setMessage(`邀请码已生成：${invitation.code}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const onReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const account = users.find((u) => u.id === userId)
    if (!account || !window.confirm(`确定重置「${account.username}」的密码？`)) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await resetPassword(userId, password)
      if (userId === user?.id) await refresh()
      setPassword('')
      setMessage(`已重置「${account.username}」的密码，请将新密码交给用户。`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const copy = (code: string) => {
    void navigator.clipboard?.writeText(code).then(() => setCopied(code), () => setError('复制失败，请手动选中邀请码'))
  }

  return <section className="adm-page" aria-label="账号管理">
    <header className="adm-page-head"><div><h2>账号</h2><p className="hint">注册需要邀请码；用户忘记密码时由管理员重置。</p></div></header>
    {!loaded && !error && <p className="adm-empty" role="status">正在加载管理员数据…</p>}
    {error && <p className="adm-note err" role="alert">{error}</p>}
    {message && <p className="adm-note" role="status">{message}</p>}
    <div className="adm-grid">
      <div className="adm-card">
        <div className="adm-card-head"><div><h3>邀请码</h3><p className="hint">每个邀请码可被使用的注册次数。</p></div></div>
        <form className="adm-inline" onSubmit={(e) => void onCreate(e)}>
          <label className="adm-field">可用次数<input type="number" min="1" max="2147483647" step="1" required value={maxUses} onChange={(e) => setMaxUses(e.target.value)} disabled={busy} /></label>
          <button type="submit" className="btn primary" disabled={busy || !loaded}>生成邀请码</button>
        </form>
        {loaded && (invitations.length === 0 ? <p className="adm-empty">还没有邀请码</p> : <div className="adm-table-wrap" style={{ marginTop: 16 }}><table className="adm-table">
          <thead><tr><th>邀请码</th><th className="num">已用 / 上限</th><th /></tr></thead>
          <tbody>{invitations.map((invitation) => <tr key={invitation.code}>
            <td className="clip" title={invitation.code}><code>{invitation.code}</code></td>
            <td className="num">{invitation.usedCount} / {invitation.maxUses}</td>
            <td><div className="row-actions"><button type="button" className="btn ghost" onClick={() => copy(invitation.code)}>{copied === invitation.code ? '已复制' : '复制'}</button></div></td>
          </tr>)}</tbody>
        </table></div>)}
      </div>
      <div className="adm-card">
        <div className="adm-card-head"><div><h3>重置密码</h3><p className="hint">重置后用户需用新密码重新登录。</p></div></div>
        <form className="adm-form" onSubmit={(e) => void onReset(e)}>
          <label className="adm-field">用户<select required value={userId} onChange={(e) => setUserId(e.target.value)} disabled={busy || !loaded}>
            {users.length === 0 && <option value="">暂无用户</option>}
            {users.map((account) => <option key={account.id} value={account.id}>{account.username}{account.role === 'ADMIN' ? '（管理员）' : ''}</option>)}
          </select></label>
          <label className="adm-field">新密码<input type="password" required minLength={8} maxLength={128} title="8–128 个字符" placeholder="8–128 个字符" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} /></label>
          <div className="adm-actions"><button type="submit" className="btn danger" disabled={busy || !loaded || !userId}>重置密码</button></div>
        </form>
      </div>
    </div>
  </section>
}
