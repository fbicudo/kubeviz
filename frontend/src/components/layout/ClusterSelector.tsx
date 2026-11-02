import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useClusterInfo, useContexts, useSwitchContext } from '@/lib/queries'
import { cn } from '@/lib/utils'

/** Mostra o cluster conectado e, no modo local, permite trocar de contexto. */
export function ClusterSelector() {
  const { t } = useTranslation()
  const id = useId()
  const info = useClusterInfo()
  const contexts = useContexts()
  const switchContext = useSwitchContext()

  const reachable = info.data?.reachable
  const dot = info.isPending ? 'bg-subtle' : reachable ? 'bg-ok' : 'bg-critical'
  const status = info.isPending
    ? t('cluster.checking')
    : reachable
      ? t('cluster.reachable')
      : t('cluster.unreachable')

  const list = contexts.data?.contexts ?? []
  const canSwitch = contexts.data?.mode === 'local' && list.length > 1
  const name =
    info.data?.mode === 'in-cluster' ? t('cluster.inCluster') : (info.data?.context ?? t('header.noCluster'))

  return (
    <div className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs" title={info.data?.error ?? info.data?.server}>
      <span className={cn('size-2 shrink-0 rounded-full', dot)} role="img" aria-label={status} />
      <label htmlFor={id} className="text-subtle">
        {t('header.cluster')}
      </label>
      {canSwitch ? (
        <select
          id={id}
          className="max-w-56 truncate bg-transparent text-foreground outline-none"
          value={info.data?.context ?? ''}
          disabled={switchContext.isPending}
          onChange={(e) => switchContext.mutate(e.target.value)}
        >
          {list.map((c) => (
            <option key={c.name} value={c.name} className="bg-surface">
              {c.name}
            </option>
          ))}
        </select>
      ) : (
        <span id={id} className="max-w-56 truncate text-foreground">
          {name}
        </span>
      )}
      {info.data?.version && <span className="font-mono text-subtle">{info.data.version}</span>}
      {switchContext.isError && (
        <span className="text-critical" role="alert">
          {t('cluster.switchFailed')}
        </span>
      )}
    </div>
  )
}
