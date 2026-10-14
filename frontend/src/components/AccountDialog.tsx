/** 账号弹窗：登录、邀请码注册、退出及管理员入口，在当前图谱上完成账号操作。 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../useAuth'
import { apiUrl } from '../api'
import './account.css'

export function AccountButton() {
  const { user, openAccount } = useAuth()
  return <button type="button" className="btn ghost account-button" onClick={() => openAccount()} title={user?.username}>
    {user ? user.username : '登录 / 注册'}
  </button>
}

export function AccountDialog() {
  const auth = useAuth()
  const dialog = useRef<HTMLDialogElement>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const registering = auth.view === 'register'
  const title = auth.user ? '我的账号' : registering ? '凭邀请码注册' : '登录织影'

  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (registering) await auth.signUp({ username, password, inviteCode })
      else await auth.signIn({ username, password })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const onLogout = async () => {
    setBusy(true)
    setError('')
    try {
      await auth.signOut()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return <dialog ref={dialog} className="account-dialog" aria-labelledby="account-title" onCancel={auth.closeAccount} onKeyDown={(e) => e.stopPropagation()}>
    <div className="account-heading">
      <h2 id="account-title">{title}</h2>
      <button type="button" className="btn ghost" aria-label="关闭账号窗口" onClick={auth.closeAccount}>✕</button>
    </div>
    {auth.notice && <p role="status">{auth.notice}</p>}
    {error && <p className="account-error" role="alert">{error}</p>}
    {auth.user ? <>
      <p className="account-identity">{auth.user.username} <span className="pill">{auth.user.role === 'ADMIN' ? '管理员' : '用户'}</span></p>
      <div className="account-actions">
        {auth.user.role === 'ADMIN' && <a className="btn" href={apiUrl('/admin')}>后台管理 →</a>}
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void onLogout()}>{busy ? '正在退出…' : '退出登录'}</button>
      </div>
    </> : <>
      <div className="seg account-tabs" aria-label="账号操作">
        <button type="button" className={!registering ? 'on' : ''} aria-pressed={!registering} onClick={() => auth.openAccount('login')} disabled={busy}>登录</button>
        <button type="button" className={registering ? 'on' : ''} aria-pressed={registering} onClick={() => auth.openAccount('register')} disabled={busy}>邀请码注册</button>
      </div>
      <form className="account-form" onSubmit={(e) => void onSubmit(e)}>
        <label>用户名<input name="username" autoComplete="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_]{3,32}" title="3–32 位字母、数字或下划线" value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} /></label>
        <label>密码<input name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} required minLength={8} maxLength={128} title="8–128 个字符" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} /></label>
        {registering && <label>邀请码<input name="inviteCode" autoComplete="off" required value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} disabled={busy} /></label>}
        <button type="submit" className="btn primary" disabled={busy}>{busy ? '正在提交…' : registering ? '注册并登录' : '登录'}</button>
      </form>
      <p className="hint">上传自己的书需要登录；示例书可直接浏览。忘记密码请联系管理员重置。</p>
    </>}
  </dialog>
}
