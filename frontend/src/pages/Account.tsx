import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fingerprint, Trash2, TriangleAlert } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionDialog } from '@/components/ui/action-dialog'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api'
import { age } from '@/lib/format'
import { useSession } from '@/lib/queries'
import { useNow } from '@/lib/use-now'
import { cancelled, deletePasskey, listPasskeys, passkeySupport, registerPasskey, suggestedPasskeyName, type PasskeyInfo } from '@/lib/webauthn'

const passkeysKey = ['me', 'passkeys'] as const

/** Minha conta: as passkeys da pessoa (contas locais). */
export function Account() {
  const { t } = useTranslation()
  const session = useSession()
  const now = useNow()
  const qc = useQueryClient()
  const nameId = useId()
  const support = passkeySupport()
  const [name, setName] = useState(suggestedPasskeyName)
  const [removing, setRemoving] = useState<PasskeyInfo | null>(null)
  const passkeys = useQuery({ queryKey: passkeysKey, queryFn: listPasskeys, enabled: !!session.data?.localUser })
  const refresh = () => void qc.invalidateQueries({ queryKey: passkeysKey })
  const add = useMutation({ mutationFn: () => registerPasskey(name.trim()), onSuccess: refresh })

  const host = window.location.hostname
  const nameHost = `${host}.nip.io${window.location.port ? `:${window.location.port}` : ''}`
  let addError: string | null = null
  if (add.error) {
    addError = cancelled(add.error)
      ? t('account.passkeys.cancelled')
      : add.error instanceof ApiError && add.error.status === 409
        ? t('account.passkeys.exists')
        : add.error.message
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{t('account.title')}</h1>
        <p className="text-muted">
          {session.data?.localUser} · {t('account.subtitle')}
        </p>
      </div>

      <section className="space-y-3 rounded-lg border bg-surface p-4" aria-labelledby={`${nameId}-title`}>
        <h2 id={`${nameId}-title`} className="flex items-center gap-2 font-semibold">
          <Fingerprint className="size-4 text-accent" aria-hidden />
          {t('account.passkeys.title')}
        </h2>
        <p className="text-muted">{t('account.passkeys.hint')}</p>

        {support !== 'ok' ? (
          <p className="flex gap-2 rounded-md border border-warn/40 bg-warn/5 p-3 text-warn">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t(`account.passkeys.unsupported.${support}`, { host: nameHost })}
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1 space-y-1">
              <label htmlFor={nameId} className="block font-medium">
                {t('account.passkeys.name')}
              </label>
              <input
                id={nameId}
                value={name}
                maxLength={64}
                onChange={(e) => setName(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 focus:border-accent focus:outline-none"
              />
            </div>
            <Button variant="primary" className="h-9" onClick={() => add.mutate()} disabled={add.isPending || !name.trim()}>
              <Fingerprint />
              {t('account.passkeys.add')}
            </Button>
          </div>
        )}
        {addError && (
          <p role="alert" className={cancelled(add.error) ? 'text-muted' : 'text-critical'}>
            {addError}
          </p>
        )}
        {add.isSuccess && <p className="text-ok">{t('account.passkeys.added')}</p>}

        <ul className="divide-y rounded-md border" aria-label={t('account.passkeys.title')}>
          {passkeys.data?.passkeys.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2">
              <Fingerprint className="size-4 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {p.name}
                  {p.synced && <span className="ml-2 text-xs font-normal text-muted">({t('account.passkeys.synced')})</span>}
                </div>
                <div className="text-xs text-muted">
                  {t('account.passkeys.created', { age: age(p.created, now) })} ·{' '}
                  {p.lastUsed ? t('account.passkeys.used', { age: age(p.lastUsed, now) }) : t('account.passkeys.never')}
                </div>
              </div>
              <Button size="sm" variant="ghost" className="text-critical" onClick={() => setRemoving(p)} aria-label={t('account.passkeys.remove', { name: p.name })}>
                <Trash2 />
              </Button>
            </li>
          ))}
          {passkeys.data?.passkeys.length === 0 && <li className="px-3 py-4 text-center text-muted">{t('account.passkeys.empty')}</li>}
        </ul>
        {support === 'ok' && <p className="text-xs text-muted">{t('account.passkeys.hostBound', { host })}</p>}
      </section>

      {removing && (
        <ActionDialog
          open
          onOpenChange={() => setRemoving(null)}
          title={t('account.passkeys.removeTitle', { name: removing.name })}
          description={t('account.passkeys.removeHint')}
          confirmLabel={t('actions.delete')}
          danger
          onConfirm={() => deletePasskey(removing.id).then(refresh)}
        />
      )}
    </div>
  )
}
