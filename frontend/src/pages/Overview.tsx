import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { StatTile } from '@/components/ui/stat-tile'
import { Link } from '@tanstack/react-router'
import { ApiError, getVersion } from '@/lib/api'
import { isNodeReady, summarizePod } from '@/lib/k8s/pods'
import { useNodes, useNodesLive, usePods, usePodsLive } from '@/lib/k8s/queries'
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
        <NodesTile />
        <PodsTile />
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

/** Mensagem curta para indicadores que falharam (ex.: sem permissão). */
function errorHint(t: (k: string) => string, error: Error) {
  return error instanceof ApiError && error.status === 403 ? t('overview.forbidden') : error.message
}

/** Com o cluster fora do ar, os indicadores dizem isso em vez de "carregando". */
function useClusterDown() {
  const { data } = useClusterInfo()
  return data !== undefined && !data.reachable
}

function NodesTile() {
  const { t } = useTranslation()
  const nodes = useNodes()
  useNodesLive(nodes.isSuccess)
  if (useClusterDown()) {
    return <StatTile label={t('overview.nodes')} status="critical" value="—" hint={t('cluster.unreachable')} />
  }
  if (nodes.isError) {
    return <StatTile label={t('overview.nodes')} value="—" hint={errorHint(t, nodes.error)} />
  }
  const items = nodes.data?.items ?? []
  const ready = items.filter(isNodeReady).length
  return (
    <StatTile
      label={t('overview.nodes')}
      status={!nodes.data ? 'unknown' : ready === items.length ? 'ok' : ready === 0 ? 'critical' : 'warn'}
      value={nodes.data ? `${ready}/${items.length}` : '…'}
      hint={nodes.data && ready < items.length ? t('overview.nodesNotReady', { count: items.length - ready }) : undefined}
    />
  )
}

function PodsTile() {
  const { t } = useTranslation()
  const pods = usePods('')
  usePodsLive('', pods.isSuccess)
  if (useClusterDown()) {
    return <StatTile label={t('overview.pods')} status="critical" value="—" hint={t('cluster.unreachable')} />
  }
  if (pods.isError) {
    return <StatTile label={t('overview.pods')} value="—" hint={errorHint(t, pods.error)} />
  }
  const summaries = (pods.data?.items ?? []).map(summarizePod)
  const running = summaries.filter((s) => s.status === 'Running').length
  const failing = summaries.filter((s) => s.severity === 'critical').length
  return (
    <StatTile
      label={t('overview.pods')}
      status={!pods.data ? 'unknown' : failing > 0 ? 'critical' : 'ok'}
      value={pods.data ? `${running}/${summaries.length}` : '…'}
      hint={
        pods.data ? (
          <Link to="/pods" className="hover:text-foreground">
            {failing > 0 ? t('overview.podsFailing', { count: failing }) : t('overview.podsAllGood')}
          </Link>
        ) : undefined
      }
    />
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
