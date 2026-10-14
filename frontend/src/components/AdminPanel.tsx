/** 管理员账号工具：生成并查看邀请码，为指定用户重置密码。 */
import { useEffect, useState, type FormEvent } from 'react'
import { createInvitation, listInvitations, listUsers, resetPassword, type Invitation, type User } from '../authApi'
import { useAuth } from '../useAuth'

export function AdminPanel() {
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

  return (
    <div className="account-admin">
      {!loaded && !error && <p role="status">正在加载管理员数据…</p>}
      {error && <p className="account-error" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <form className="account-form" onSubmit={(e) => void onCreate(e)}>
        <h3>邀请码</h3>
        <label>可用次数<input type="number" min="1" max="2147483647" step="1" required value={maxUses} onChange={(e) => setMaxUses(e.target.value)} disabled={busy} /></label>
        <button type="submit" className="btn primary" disabled={busy || !loaded}>生成邀请码</button>
      </form>
      {invitations.length > 0 && <div className="account-table-wrap">
        <table className="account-table">
          <caption>已生成的邀请码</caption>
          <thead><tr><th scope="col">邀请码</th><th scope="col">已用 / 上限</th></tr></thead>
          <tbody>{invitations.map((invitation) => <tr key={invitation.code}>
            <td><code>{invitation.code}</code></td><td>{invitation.usedCount} / {invitation.maxUses}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      <form className="account-form" onSubmit={(e) => void onReset(e)}>
        <h3>重置密码</h3>
        <label>用户<select required value={userId} onChange={(e) => setUserId(e.target.value)} disabled={busy || !loaded}>
          {users.length === 0 && <option value="">暂无用户</option>}
          {users.map((account) => <option key={account.id} value={account.id}>{account.username}{account.role === 'ADMIN' ? '（管理员）' : ''}</option>)}
        </select></label>
        <label>新密码<input type="password" required minLength={8} maxLength={128} title="8–128 个字符" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} /></label>
        <button type="submit" className="btn" disabled={busy || !loaded || !userId}>重置密码</button>
      </form>
    </div>
  )
}
