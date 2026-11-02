import { KeyRound, LogIn, Terminal } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ApiError, type LoginMethod } from '@/lib/api'
import { useLogin, usePasswordLogin } from '@/lib/queries'

const fieldClass =
  'h-9 w-full rounded-md border bg-background px-2 focus:border-accent focus:outline-none'

export function Login({ methods }: { methods: LoginMethod[] }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border bg-surface p-6">
        <div className="mb-5 flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-9" />
          <div>
            <h1 className="text-base font-semibold">{t('auth.title')}</h1>
            <p className="text-muted">{t('app.tagline')}</p>
          </div>
        </div>
        {methods.includes('password') ? <PasswordForm /> : methods.includes('token') ? <TokenForm /> : <LocalHelp />}
      </div>
    </div>
  )
}

function LocalHelp() {
  const { t } = useTranslation()
  return (
    <div className="flex gap-3">
      <Terminal className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
      <div className="space-y-2">
        <p>{t('auth.local.body')}</p>
        <p className="text-muted">{t('auth.local.hint')}</p>
      </div>
    </div>
  )
}

function TokenForm() {
  const { t } = useTranslation()
  const id = useId()
  const [token, setToken] = useState('')
  const loginMutation = useLogin()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (token.trim()) loginMutation.mutate(token.trim())
  }

  const error = loginMutation.error
  const errorText =
    error instanceof ApiError && error.status === 401 ? t('auth.token.invalid') : error?.message

  return (
    <form onSubmit={submit} className="space-y-3">
      <label htmlFor={id} className="block font-medium">
        {t('auth.token.label')}
      </label>
      {/* Campo de senha: o token não fica visível para quem olha a tela. */}
      <input
        id={id}
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="h-9 w-full rounded-md border bg-background px-2 font-mono text-xs focus:border-accent focus:outline-none"
        placeholder="eyJhbGciOiJSUzI1NiIs…"
      />
      <p className="text-xs text-muted">
        {t('auth.token.help')}{' '}
        <code className="rounded bg-surface-raised px-1 font-mono">kubectl create token &lt;serviceaccount&gt; -n &lt;namespace&gt;</code>
      </p>
      {errorText && (
        <p role="alert" className="text-critical">
          {errorText}
        </p>
      )}
      <Button type="submit" variant="primary" className="w-full" disabled={!token.trim() || loginMutation.isPending}>
        <KeyRound />
        {t('auth.token.submit')}
      </Button>
    </form>
  )
}

function PasswordForm() {
  const { t } = useTranslation()
  const userId = useId()
  const passId = useId()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const loginMutation = usePasswordLogin()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (username.trim() && password) loginMutation.mutate({ username: username.trim(), password })
  }

  const error = loginMutation.error
  let errorText = error?.message
  if (error instanceof ApiError && error.status === 401) errorText = t('auth.password.invalid')
  if (error instanceof ApiError && error.status === 429) errorText = t('auth.password.tooMany', { minutes: 15 })

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={userId} className="block font-medium">
          {t('auth.password.username')}
        </label>
        <input
          id={userId}
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className={fieldClass}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={passId} className="block font-medium">
          {t('auth.password.password')}
        </label>
        <input
          id={passId}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={fieldClass}
        />
      </div>
      {errorText && (
        <p role="alert" className="text-critical">
          {errorText}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        className="w-full"
        disabled={!username.trim() || !password || loginMutation.isPending}
      >
        <LogIn />
        {t('auth.password.submit')}
      </Button>
      <p className="text-xs text-muted">{t('auth.password.hint')}</p>
    </form>
  )
}
