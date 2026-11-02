import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { StatTile } from '@/components/ui/stat-tile'
import { getVersion } from '@/lib/api'
import { useClusterInfo } from '@/lib/queries'

export function Overview() {
  const { t } = useTranslation()
  const version = useQuery({ queryKey: ['version'], queryFn: getVersion })

  const backend = version.isSuccess
    ? { status: 'ok' as const, value: t('overview.backendOk', { version: version.data.version }) }
    : version.isError
      ? { status: 'critical' as const, value: t('overview.backendDown') }
      : { status: 'unknown' as const, value: '…' }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{t('overview.title')}</h1>
        <p className="text-muted">{t('overview.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label={t('overview.nodes')} value="—" hint={t('overview.pending')} />
        <StatTile label={t('overview.pods')} value="—" hint={t('overview.pending')} />
        <StatTile label={t('overview.cpu')} value="—" hint={t('overview.pending')} />
        <StatTile label={t('overview.memory')} value="—" hint={t('overview.pending')} />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:max-w-4xl">
        <ClusterTile />
        <StatTile
          label={t('overview.backend')}
          status={backend.status}
          value={<span className="text-sm">{backend.value}</span>}
        />
      </div>
    </div>
  )
}

function ClusterTile() {
  const { t } = useTranslation()
  const { data, isPending } = useClusterInfo()

  if (isPending || !data) {
    return <StatTile label={t('cluster.title')} value={<span className="text-sm">…</span>} />
  }
  return (
    <StatTile
      label={t('cluster.title')}
      status={data.reachable ? 'ok' : 'critical'}
      value={
        <span className="text-sm">
          {data.reachable ? `${data.version} · ${data.platform}` : t('cluster.unreachable')}
        </span>
      }
      hint={
        <>
          {t(`cluster.mode.${data.mode}`)} · <span className="font-mono">{data.server}</span>
          {data.error && <span className="mt-1 block break-all text-critical">{data.error}</span>}
        </>
      }
    />
  )
}
