import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionDialog } from '@/components/ui/action-dialog'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
import { splitList, useAccounts, useCreateAccount, useDeleteAccount, useSetDomains, useUpdateAccount, type Account } from '@/lib/admin'
import { age } from '@/lib/format'
import { useNow } from '@/lib/use-now'

const fieldClass = 'h-9 w-full rounded-md border bg-background px-2 focus:border-accent focus:outline-none'
const areaClass = 'w-full rounded-md border bg-background p-2 font-mono text-xs focus:border-accent focus:outline-none'

/** Contas do KubeViz (modo local): quem entra e como. Só administradores. */
export function AdminUsers() {
  const { t } = useTranslation()
  const now = useNow()
  const accounts = useAccounts()
  const [editing, setEditing] = useState<Account | 'new' | null>(null)
  const [removing, setRemoving] = useState<Account | null>(null)
  const deleteAccount = useDeleteAccount()

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto">
          <h1 className="text-lg font-semibold">{t('nav.adminUsers')}</h1>
          <p className="text-muted">{t('admin.users.subtitle')}</p>
        </div>
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus />
          {t('admin.users.new')}
        </Button>
      </div>

      {accounts.isError && <p className="text-critical">{accounts.error.message}</p>}
      <div className="overflow-x-auto rounded-lg border bg-surface">
        <table className="w-full text-left">
          <thead className="border-b text-xs text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">{t('admin.users.col.name')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('admin.users.col.login')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('admin.users.col.role')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('admin.users.col.created')}</th>
              <th scope="col" className="px-3 py-2 font-medium"><span className="sr-only">{t('admin.users.col.actions')}</span></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {accounts.data?.accounts.map((a) => (
              <tr key={a.name} className="align-top hover:bg-surface-raised">
                <td className="px-3 py-2 font-medium whitespace-nowrap">
                  {a.name}
                  {a.current && <span className="ml-2 text-xs text-muted">({t('admin.users.you')})</span>}
                </td>
                <td className="px-3 py-2">
                  <ul className="space-y-0.5">
                    {a.hasPassword && <li>{t('admin.users.password')}</li>}
                    {a.emails.map((e) => (
                      <li key={e} className="font-mono text-xs">{e}</li>
                    ))}
                  </ul>
                </td>
                <td className="px-3 py-2">
                  <StatusBadge severity={a.admin ? 'ok' : 'unknown'}>{a.admin ? t('admin.users.admin') : t('admin.users.user')}</StatusBadge>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted">{a.created ? age(a.created, now) : '—'}</td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(a)} aria-label={t('admin.users.edit', { name: a.name })}>
                      <Pencil />
                    </Button>
                    <Button size="sm" variant="ghost" className="text-critical" onClick={() => setRemoving(a)} aria-label={t('admin.users.remove', { name: a.name })}>
                      <Trash2 />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {accounts.isPending && <p className="p-6 text-center text-muted">{t('resources.loading')}</p>}
      </div>

      {/* Montado uma vez: recarregar a lista não apaga o que está sendo digitado nem o aviso de salvo. */}
      {accounts.data && <DomainsCard domains={accounts.data.allowedDomains} />}

      {editing && <AccountDialog account={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {removing && (
        <ActionDialog
          open
          onOpenChange={() => setRemoving(null)}
          title={t('admin.users.removeTitle', { name: removing.name })}
          description={removing.current ? t('admin.users.removeSelf') : t('admin.users.removeHint')}
          confirmLabel={t('actions.delete')}
          danger
          onConfirm={() => deleteAccount.mutateAsync(removing.name).then(() => undefined)}
        />
      )}
    </div>
  )
}

/** Criar ou editar uma conta. */
function AccountDialog({ account, onClose }: { account?: Account; onClose: () => void }) {
  const { t } = useTranslation()
  const ids = { name: useId(), password: useId(), emails: useId() }
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [removePassword, setRemovePassword] = useState(false)
  const [emails, setEmails] = useState(account?.emails.join('\n') ?? '')
  const [admin, setAdmin] = useState(account?.admin ?? false)
  const create = useCreateAccount()
  const update = useUpdateAccount()

  const confirm = async () => {
    const list = splitList(emails)
    if (!account) {
      await create.mutateAsync({ name: name.trim(), password: password || undefined, emails: list, admin })
      return
    }
    await update.mutateAsync({
      name: account.name,
      password: password || undefined,
      removePassword: removePassword && !password,
      emails: list,
      admin,
    })
  }

  return (
    <ActionDialog
      open
      onOpenChange={onClose}
      title={account ? t('admin.users.editTitle', { name: account.name }) : t('admin.users.newTitle')}
      description={t('admin.users.dialogHint')}
      confirmLabel={account ? t('admin.users.save') : t('admin.users.create')}
      disabled={!account && !name.trim()}
      onConfirm={confirm}
    >
      {!account && (
        <div className="space-y-1">
          <label htmlFor={ids.name} className="block font-medium">{t('auth.password.username')}</label>
          <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="none" spellCheck={false} className={fieldClass} />
        </div>
      )}
      <div className="space-y-1">
        <label htmlFor={ids.password} className="block font-medium">
          {account?.hasPassword ? t('admin.users.newPassword') : t('auth.password.password')}
        </label>
        <input id={ids.password} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={fieldClass} />
        <p className="text-xs text-muted">{account?.hasPassword ? t('admin.users.keepPassword') : t('admin.users.passwordOptional')}</p>
        {account?.hasPassword && (
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={removePassword} disabled={!!password} onChange={(e) => setRemovePassword(e.target.checked)} />
            {t('admin.users.removePassword')}
          </label>
        )}
      </div>
      <div className="space-y-1">
        <label htmlFor={ids.emails} className="block font-medium">{t('admin.users.emails')}</label>
        <textarea id={ids.emails} rows={3} value={emails} onChange={(e) => setEmails(e.target.value)} spellCheck={false} className={areaClass} placeholder="ana@gmail.com" />
        <p className="text-xs text-muted">{t('admin.users.emailsHelp')}</p>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
        {t('admin.users.makeAdmin')}
      </label>
    </ActionDialog>
  )
}

/** Domínios cujos e-mails ganham conta no primeiro acesso por um provedor. */
function DomainsCard({ domains }: { domains: string[] }) {
  const { t } = useTranslation()
  const id = useId()
  const [text, setText] = useState(domains.join('\n'))
  const save = useSetDomains()
  return (
    <section className="space-y-2 rounded-lg border bg-surface p-4" aria-labelledby={id}>
      <h2 id={id} className="font-semibold">{t('admin.domains.title')}</h2>
      <p className="text-muted">{t('admin.domains.hint')}</p>
      <textarea aria-labelledby={id} rows={2} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} className={areaClass} placeholder="empresa.com.br" />
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => save.mutate(splitList(text))} disabled={save.isPending}>
          {t('admin.users.save')}
        </Button>
        {save.isSuccess && <span className="text-xs text-ok">{t('admin.saved')}</span>}
        {save.isError && <span role="alert" className="text-xs text-critical">{save.error.message}</span>}
      </div>
    </section>
  )
}
