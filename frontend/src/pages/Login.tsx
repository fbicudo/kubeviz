import { KeyRound, Terminal } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ApiError, type ClusterMode } from '@/lib/api'
import { useLogin } from '@/lib/queries'

export function Login({ mode }: { mode: ClusterMode }) {
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
        {mode === 'local' ? <LocalHelp /> : <TokenForm />}
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
      <textarea
        id={id}
        value={token}
        onChange={(e) => setToken(e.target.value)}
        rows={4}
        autoComplete="off"
        spellCheck={false}
        className="w-full resize-none rounded-md border bg-background p-2 font-mono text-xs break-all focus:border-accent focus:outline-none"
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
