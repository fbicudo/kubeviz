import { useTranslation } from 'react-i18next'
import { Combobox } from '@/components/ui/combobox'
import { useClusterInfo, useContexts, useSwitchContext } from '@/lib/queries'
import { cn } from '@/lib/utils'

/** Mostra o cluster conectado e, no modo local, permite trocar de contexto. */
export function ClusterSelector() {
  const { t } = useTranslation()
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

  const statusLabel = (
    <>
      <span className={cn('size-2 shrink-0 rounded-full', dot)} role="img" aria-label={status} />
      <span className="text-subtle">{t('header.cluster')}</span>
    </>
  )
  const version = info.data?.version && <span className="font-mono text-subtle">{info.data.version}</span>

  return (
    <div className="flex items-center gap-2 text-xs" title={info.data?.error ?? info.data?.server}>
      {canSwitch ? (
        <Combobox
          label={t('header.cluster')}
          value={info.data?.context ?? ''}
          options={list.map((c) => ({ value: c.name, label: c.name, hint: c.namespace }))}
          onChange={(name) => name !== info.data?.context && switchContext.mutate(name)}
          disabled={switchContext.isPending}
          searchPlaceholder={t('cluster.searchContext')}
          className="h-7 max-w-80 gap-2 text-xs"
        >
          <span className="flex items-center gap-2">
            {statusLabel}
            <span className="truncate text-foreground">{name}</span>
            {version}
          </span>
        </Combobox>
      ) : (
        <div className="flex h-7 items-center gap-2 rounded-md border px-2">
          {statusLabel}
          <span className="max-w-56 truncate text-foreground">{name}</span>
          {version}
        </div>
      )}
      {switchContext.isError && (
        <span className="text-critical" role="alert">
          {t('cluster.switchFailed')}
        </span>
      )}
    </div>
  )
}
