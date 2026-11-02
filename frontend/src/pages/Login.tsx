import { ArrowLeft, Building2, KeyRound, LogIn, Terminal, UserPlus } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ApiError, type LoginMethod } from '@/lib/api'
import { useLogin, usePasswordLogin, useSignup } from '@/lib/queries'

/** Mesmo mínimo do backend (auth.MinPasswordLength). */
const MIN_PASSWORD = 12

const fieldClass =
  'h-9 w-full rounded-md border bg-background px-2 focus:border-accent focus:outline-none'

/** Motivos de falha do login OIDC que o servidor informa em ?loginError=. */
const OIDC_ERRORS = ['oidc_denied', 'oidc_state', 'oidc_claims', 'oidc_cluster', 'oidc_impersonate', 'oidc_unavailable', 'oidc_failed']

interface LoginProps {
  methods: LoginMethod[]
  oidcName?: string
  /** A tela pode criar contas locais (modo local, com o código do terminal). */
  signup?: boolean
}

export function Login({ methods, oidcName, signup }: LoginProps) {
  const { t } = useTranslation()
  const [creating, setCreating] = useState(false)
  const oidc = methods.includes('oidc')
  const others = methods.filter((m) => m !== 'oidc')
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
        {creating ? (
          <SignupForm onBack={() => setCreating(false)} />
        ) : (
          <>
            {oidc && <OidcLogin name={oidcName} />}
            {oidc && others.length > 0 && (
              <div className="my-5 flex items-center gap-3 text-xs text-subtle" aria-hidden>
                <span className="h-px flex-1 bg-border" />
                {t('auth.oidc.or')}
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            {others.includes('password') ? <PasswordForm /> : others.includes('token') ? <TokenForm /> : others.includes('link') ? <LocalHelp /> : null}
            {signup && (
              <p className="mt-5 border-t pt-4 text-center text-muted">
                {t('auth.signup.prompt')}{' '}
                <button type="button" onClick={() => setCreating(true)} className="font-medium text-accent hover:underline">
                  {t('auth.signup.open')}
                </button>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function OidcLogin({ name }: { name?: string }) {
  const { t } = useTranslation()
  // O servidor volta para /?loginError=<motivo> quando o login falha.
  const [error] = useState(() => new URLSearchParams(window.location.search).get('loginError'))
  useEffect(() => {
    if (!error) return
    const url = new URL(window.location.href)
    url.searchParams.delete('loginError')
    window.history.replaceState(window.history.state, '', url)
  }, [error])
  // Depois do login, volta para a página em que a pessoa estava.
  const here = window.location.pathname + window.location.search.replace(/[?&]loginError=[^&]*/, '')
  const href = `/auth/oidc/login${here && here !== '/' ? `?return=${encodeURIComponent(here)}` : ''}`

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="rounded-md border border-critical/40 bg-critical/5 p-2 text-critical">
          {t(`auth.oidc.errors.${OIDC_ERRORS.includes(error) ? error : 'oidc_failed'}`)}
        </p>
      )}
      <a
        href={href}
        className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-accent font-medium text-accent-foreground hover:bg-accent/90 [&_svg]:size-4"
      >
        <Building2 aria-hidden />
        {name ? t('auth.oidc.submitNamed', { name }) : t('auth.oidc.submit')}
      </a>
      <p className="text-xs text-muted">{t('auth.oidc.hint')}</p>
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

function SignupForm({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const codeId = useId()
  const userId = useId()
  const passId = useId()
  const repeatId = useId()
  const [code, setCode] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const signupMutation = useSignup()

  const short = password.length > 0 && password.length < MIN_PASSWORD
  const mismatch = repeat.length > 0 && repeat !== password
  const ready = code.trim() && username.trim() && password.length >= MIN_PASSWORD && repeat === password

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready) signupMutation.mutate({ code: code.trim(), username: username.trim(), password })
  }

  const error = signupMutation.error
  let errorText = error?.message
  if (error instanceof ApiError && error.status === 401) errorText = t('auth.signup.badCode')
  if (error instanceof ApiError && error.status === 409) errorText = t('auth.signup.exists')
  if (error instanceof ApiError && error.status === 429) errorText = t('auth.password.tooMany', { minutes: 15 })

  return (
    <form onSubmit={submit} className="space-y-3" aria-labelledby={`${codeId}-title`}>
      <h2 id={`${codeId}-title`} className="font-semibold">
        {t('auth.signup.title')}
      </h2>
      <div className="space-y-1">
        <label htmlFor={codeId} className="block font-medium">
          {t('auth.signup.code')}
        </label>
        {/* Campo de senha: o código dá acesso ao cluster e não deve ficar visível. */}
        <input
          id={codeId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className={`${fieldClass} font-mono text-xs`}
        />
        <p className="text-xs text-muted">{t('auth.signup.codeHelp')}</p>
      </div>
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
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className={fieldClass}
        />
        <p className="text-xs text-muted">{t('auth.signup.usernameHelp')}</p>
      </div>
      <div className="space-y-1">
        <label htmlFor={passId} className="block font-medium">
          {t('auth.password.password')}
        </label>
        <input
          id={passId}
          name="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={short || undefined}
          className={fieldClass}
        />
        <p className={short ? 'text-xs text-warn' : 'text-xs text-muted'}>{t('auth.signup.passwordHelp', { min: MIN_PASSWORD })}</p>
      </div>
      <div className="space-y-1">
        <label htmlFor={repeatId} className="block font-medium">
          {t('auth.signup.repeat')}
        </label>
        <input
          id={repeatId}
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          aria-invalid={mismatch || undefined}
          className={fieldClass}
        />
        {mismatch && <p className="text-xs text-warn">{t('auth.signup.mismatch')}</p>}
      </div>
      {errorText && (
        <p role="alert" className="text-critical">
          {errorText}
        </p>
      )}
      <Button type="submit" variant="primary" className="w-full" disabled={!ready || signupMutation.isPending}>
        <UserPlus />
        {t('auth.signup.submit')}
      </Button>
      <button type="button" onClick={onBack} className="flex items-center gap-1 text-xs text-muted hover:text-foreground">
        <ArrowLeft className="size-3.5" aria-hidden />
        {t('auth.signup.back')}
      </button>
    </form>
  )
}
