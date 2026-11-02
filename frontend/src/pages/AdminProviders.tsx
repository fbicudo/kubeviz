import { Check, Copy, ExternalLink, Plus, TriangleAlert } from 'lucide-react'
import { useId, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ProviderIcon } from '@/components/ui/provider-icon'
import { StatusBadge } from '@/components/ui/status-badge'
import { callbackURL, hostIsIP, useDeleteProvider, useProviders, useSaveProvider, type Provider, type ProviderType } from '@/lib/admin'

const fieldClass = 'h-9 w-full rounded-md border bg-background px-2 focus:border-accent focus:outline-none'

/** Onde cada provedor é registrado. */
const CONSOLES: Record<Exclude<ProviderType, 'oidc'>, string> = {
  google: 'https://console.cloud.google.com/apis/credentials',
  microsoft: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  github: 'https://github.com/settings/applications/new',
}

const BUILTIN: { type: Exclude<ProviderType, 'oidc'>; name: string }[] = [
  { type: 'google', name: 'Google' },
  { type: 'microsoft', name: 'Microsoft' },
  { type: 'github', name: 'GitHub' },
]

/** Endereço com nome para usar no lugar do IP: localhost na própria máquina; senão, o nip.io (resolve para o mesmo IP). */
function suggestedHost() {
  const { protocol, hostname, port } = window.location
  const host = hostname.startsWith('127.') ? 'localhost' : `${hostname}.nip.io`
  return `${protocol}//${host}${port ? `:${port}` : ''}`
}

/** Provedores de login das contas locais, configurados sem reiniciar. */
export function AdminProviders() {
  const { t } = useTranslation()
  const providers = useProviders()
  const [addingOidc, setAddingOidc] = useState(false)
  const list = providers.data?.providers ?? []
  const oidc = list.filter((p) => p.type === 'oidc')
  const ip = hostIsIP()

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{t('nav.adminProviders')}</h1>
        <p className="text-muted">{t('admin.providers.subtitle')}</p>
      </div>
      {ip && (
        <p className="flex gap-2 rounded-md border border-warn/40 bg-warn/5 p-3 text-warn">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <Trans
              i18nKey="admin.providers.ipWarning"
              values={{ url: suggestedHost() }}
              components={{ b: <span className="font-mono" /> }}
            />
          </span>
        </p>
      )}
      {providers.isError && <p className="text-critical">{providers.error.message}</p>}
      {providers.data &&
        BUILTIN.map((b) => (
          <ProviderCard key={b.type} id={b.type} type={b.type} defaultName={b.name} current={list.find((p) => p.id === b.type)} />
        ))}
      {oidc.map((p) => (
        <ProviderCard key={p.id} id={p.id} type="oidc" defaultName={p.name} current={p} />
      ))}
      {addingOidc ? (
        <ProviderCard type="oidc" defaultName="" onDone={() => setAddingOidc(false)} />
      ) : (
        <Button onClick={() => setAddingOidc(true)}>
          <Plus />
          {t('admin.providers.addOidc')}
        </Button>
      )}
    </div>
  )
}

interface CardProps {
  /** Sem id: um OIDC novo (o identificador é digitado). */
  id?: string
  type: ProviderType
  defaultName: string
  current?: Provider
  onDone?: () => void
}

function ProviderCard({ id, type, defaultName, current, onDone }: CardProps) {
  const { t } = useTranslation()
  const ids = { id: useId(), name: useId(), clientId: useId(), secret: useId(), issuer: useId(), tenant: useId(), cb: useId() }
  const [slug, setSlug] = useState(id ?? '')
  const [name, setName] = useState(current?.name ?? (type === 'oidc' ? '' : defaultName))
  const [clientId, setClientId] = useState(current?.clientId ?? '')
  const [secret, setSecret] = useState('')
  const [issuer, setIssuer] = useState(current?.issuerUrl ?? '')
  const [tenant, setTenant] = useState(current?.tenant ?? 'common')
  const [copied, setCopied] = useState(false)
  const save = useSaveProvider()
  const remove = useDeleteProvider()
  const providerId = id ?? slug.trim().toLowerCase()
  const cb = providerId ? callbackURL(providerId) : ''
  const titleId = useId()

  const submit = () =>
    save.mutate(
      { id: providerId, type, name: name.trim() || undefined, clientId, clientSecret: secret || undefined, issuerUrl: issuer || undefined, tenant: type === 'microsoft' ? tenant : undefined },
      { onSuccess: () => { setSecret(''); onDone?.() } },
    )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cb)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // sem acesso à área de transferência: o campo é selecionável
    }
  }

  return (
    <section className="space-y-3 rounded-lg border bg-surface p-4" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center gap-2">
        <ProviderIcon type={type} className="size-5" />
        <h2 id={titleId} className="mr-auto font-semibold">{current?.name || defaultName || t('admin.providers.newOidc')}</h2>
        <StatusBadge severity={current ? 'ok' : 'unknown'}>{current ? t('admin.providers.on') : t('admin.providers.off')}</StatusBadge>
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-muted">
        {type !== 'oidc' ? (
          <>
            <li>
              <Trans
                i18nKey={`admin.providers.steps.${type}.1`}
                components={{ a: <a href={CONSOLES[type]} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline" /> }}
              />
              <ExternalLink className="ml-0.5 inline size-3 text-accent" aria-hidden />
            </li>
            <li>{t(`admin.providers.steps.${type}.2`)}</li>
            <li>{t(`admin.providers.steps.${type}.3`)}</li>
          </>
        ) : (
          <li>{t('admin.providers.steps.oidc')}</li>
        )}
      </ol>
      {type === 'oidc' && !id && (
        <div className="space-y-1">
          <label htmlFor={ids.id} className="block font-medium">{t('admin.providers.id')}</label>
          <input id={ids.id} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="keycloak" className={fieldClass} />
        </div>
      )}
      {cb && (
        <div className="space-y-1">
          <label htmlFor={ids.cb} className="block font-medium">{t('admin.providers.callback')}</label>
          <div className="flex gap-2">
            <input id={ids.cb} readOnly value={cb} onFocus={(e) => e.target.select()} className={`${fieldClass} font-mono text-xs`} />
            <Button size="icon" onClick={() => void copy()} aria-label={t('admin.providers.copy')}>
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {type === 'oidc' && (
          <>
            <div className="space-y-1">
              <label htmlFor={ids.name} className="block font-medium">{t('admin.providers.name')}</label>
              <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} placeholder="Keycloak" className={fieldClass} />
            </div>
            <div className="space-y-1">
              <label htmlFor={ids.issuer} className="block font-medium">{t('admin.providers.issuer')}</label>
              <input id={ids.issuer} value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://sso.empresa.com/realms/x" className={fieldClass} />
            </div>
          </>
        )}
        <div className="space-y-1">
          <label htmlFor={ids.clientId} className="block font-medium">{t('admin.providers.clientId')}</label>
          <input id={ids.clientId} value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} className={`${fieldClass} font-mono text-xs`} />
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.secret} className="block font-medium">{t('admin.providers.secret')}</label>
          <input
            id={ids.secret}
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={current?.hasSecret ? t('admin.providers.keepSecret') : ''}
            className={`${fieldClass} font-mono text-xs`}
          />
        </div>
        {type === 'microsoft' && (
          <div className="space-y-1 sm:col-span-2">
            <label htmlFor={ids.tenant} className="block font-medium">{t('admin.providers.tenant')}</label>
            <input id={ids.tenant} value={tenant} onChange={(e) => setTenant(e.target.value)} className={`${fieldClass} font-mono text-xs`} />
            <p className="text-xs text-muted">{t('admin.providers.tenantHelp')}</p>
          </div>
        )}
      </div>
      {save.isError && <p role="alert" className="text-critical">{save.error.message}</p>}
      {remove.isError && <p role="alert" className="text-critical">{remove.error.message}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={submit} disabled={save.isPending || !providerId || !clientId.trim() || (!secret && !current?.hasSecret)}>
          {t('admin.users.save')}
        </Button>
        {save.isSuccess && <span className="text-xs text-ok">{t('admin.saved')}</span>}
        {current && (
          <Button size="sm" className="text-critical" onClick={() => remove.mutate(current.id)} disabled={remove.isPending}>
            {t('admin.providers.remove')}
          </Button>
        )}
        {!current && onDone && (
          <Button size="sm" variant="ghost" onClick={onDone}>
            {t('edit.cancel')}
          </Button>
        )}
      </div>
    </section>
  )
}
