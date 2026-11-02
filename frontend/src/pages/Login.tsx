import { Building2, Fingerprint, KeyRound, LogIn, ShieldCheck, Terminal } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ProviderIcon } from '@/components/ui/provider-icon'
import { ApiError, type LoginMethod, type LoginProvider } from '@/lib/api'
import { sessionKey, useLogin, usePasswordLogin, useSetupAdmin } from '@/lib/queries'
import { cancelled, loginWithPasskey, passkeySupport } from '@/lib/webauthn'
import { useMutation, useQueryClient } from '@tanstack/react-query'

/** Mesmo mínimo do backend (auth.MinPasswordLength). */
const MIN_PASSWORD = 12

const fieldClass =
  'h-9 w-full rounded-md border bg-background px-2 focus:border-accent focus:outline-none'

/** Motivos de falha que o servidor informa em ?loginError= (login OIDC e por provedor). */
const LOGIN_ERRORS = [
  'oidc_denied', 'oidc_state', 'oidc_claims', 'oidc_cluster', 'oidc_impersonate', 'oidc_unavailable', 'oidc_failed',
  'provider_denied', 'provider_state', 'provider_email', 'provider_unauthorized', 'provider_unavailable', 'provider_failed',
]

interface LoginProps {
  methods: LoginMethod[]
  oidcName?: string
  /** Primeiro acesso (modo local sem contas). */
  setup?: 'available' | 'expired'
  /** Provedores das contas locais (Google, Microsoft, GitHub, OIDC). */
  providers?: LoginProvider[]
  /** Contas locais podem entrar com passkey. */
  passkeys?: boolean
}

/** Motivo da falha do último login (?loginError=), tirado da barra de endereços. */
function useLoginError() {
  const [error] = useState(() => new URLSearchParams(window.location.search).get('loginError'))
  useEffect(() => {
    if (!error) return
    const url = new URL(window.location.href)
    url.searchParams.delete('loginError')
    window.history.replaceState(window.history.state, '', url)
  }, [error])
  return error
}

/** Para onde voltar depois do login: a página em que a pessoa estava. */
function returnQuery() {
  const here = window.location.pathname + window.location.search.replace(/[?&]loginError=[^&]*/, '')
  return here && here !== '/' ? `?return=${encodeURIComponent(here)}` : ''
}

export function Login({ methods, oidcName, setup, providers = [], passkeys }: LoginProps) {
  const { t } = useTranslation()
  const error = useLoginError()
  const oidc = methods.includes('oidc')
  const others = methods.filter((m) => m !== 'oidc')
  // O navegador só aceita passkeys num endereço com nome e em contexto seguro.
  const withPasskey = passkeys && passkeySupport() === 'ok'
  const external = oidc || providers.length > 0 || withPasskey

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border bg-surface p-6">
        <div className="mb-5 flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-9" />
          <div>
            <h1 className="text-base font-semibold">{setup === 'available' ? t('auth.setup.title') : t('auth.title')}</h1>
            <p className="text-muted">{t('app.tagline')}</p>
          </div>
        </div>
        {error && (
          <p role="alert" className="mb-4 rounded-md border border-critical/40 bg-critical/5 p-2 text-critical">
            {t(`auth.errors.${LOGIN_ERRORS.includes(error) ? error : 'oidc_failed'}`)}
          </p>
        )}
        {setup === 'available' ? (
          <SetupForm />
        ) : (
          <>
            {setup === 'expired' && (
              <p className="mb-4 rounded-md border border-warn/40 bg-warn/5 p-2 text-warn">{t('auth.setup.expired')}</p>
            )}
            {oidc && <OidcLogin name={oidcName} />}
            {withPasskey && <PasskeyLogin />}
            {providers.length > 0 && (
              <div className={withPasskey ? 'mt-2 space-y-2' : 'space-y-2'}>
                {providers.map((p) => (
                  <a
                    key={p.id}
                    href={`/auth/provider/${p.id}/login${returnQuery()}`}
                    className="flex h-9 w-full items-center justify-center gap-2 rounded-md border bg-background font-medium hover:bg-surface-raised"
                  >
                    <ProviderIcon type={p.type} className="size-4" />
                    {t('auth.providers.continue', { name: p.name })}
                  </a>
                ))}
              </div>
            )}
            {external && others.length > 0 && (
              <div className="my-5 flex items-center gap-3 text-xs text-subtle" aria-hidden>
                <span className="h-px flex-1 bg-border" />
                {t('auth.oidc.or')}
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            {others.includes('password') ? <PasswordForm /> : others.includes('token') ? <TokenForm /> : others.includes('link') ? <LocalHelp /> : null}
          </>
        )}
      </div>
    </div>
  )
}

function PasskeyLogin() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const login = useMutation({
    mutationFn: loginWithPasskey,
    onSuccess: (session) => qc.setQueryData(sessionKey, session),
  })
  const error = login.error
  const errorText = !error || cancelled(error) ? null : error instanceof ApiError && error.status === 401 ? t('account.passkeys.unknown') : error.message
  return (
    <div className="space-y-2">
      <Button variant="primary" className="h-9 w-full" onClick={() => login.mutate()} disabled={login.isPending}>
        <Fingerprint />
        {t('account.passkeys.login')}
      </Button>
      {errorText && (
        <p role="alert" className="text-critical">
          {errorText}
        </p>
      )}
    </div>
  )
}

function OidcLogin({ name }: { name?: string }) {
  const { t } = useTranslation()
  return (
    <div className="mb-2 space-y-3">
      <a
        href={`/auth/oidc/login${returnQuery()}`}
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

/** Primeiro acesso: cria a conta de administrador (sem código, sem terminal). */
function SetupForm() {
  const { t } = useTranslation()
  const userId = useId()
  const passId = useId()
  const repeatId = useId()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const setupMutation = useSetupAdmin()

  const short = password.length > 0 && password.length < MIN_PASSWORD
  const mismatch = repeat.length > 0 && repeat !== password
  const ready = username.trim() && password.length >= MIN_PASSWORD && repeat === password

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready) setupMutation.mutate({ username: username.trim(), password })
  }

  const error = setupMutation.error
  const errorText = error instanceof ApiError && error.status === 409 ? t('auth.setup.taken') : error?.message

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="flex gap-2 text-muted">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
        {t('auth.setup.intro')}
      </p>
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
        <p className="text-xs text-muted">{t('auth.setup.usernameHelp')}</p>
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
        <p className={short ? 'text-xs text-warn' : 'text-xs text-muted'}>{t('auth.setup.passwordHelp', { min: MIN_PASSWORD })}</p>
      </div>
      <div className="space-y-1">
        <label htmlFor={repeatId} className="block font-medium">
          {t('auth.setup.repeat')}
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
        {mismatch && <p className="text-xs text-warn">{t('auth.setup.mismatch')}</p>}
      </div>
      {errorText && (
        <p role="alert" className="text-critical">
          {errorText}
        </p>
      )}
      <Button type="submit" variant="primary" className="w-full" disabled={!ready || setupMutation.isPending}>
        <ShieldCheck />
        {t('auth.setup.submit')}
      </Button>
      <p className="text-xs text-muted">{t('auth.setup.after')}</p>
    </form>
  )
}
