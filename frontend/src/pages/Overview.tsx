import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { HealthPanel } from '@/components/health/HealthPanel'
import { StatTile } from '@/components/ui/stat-tile'
import { Link } from '@tanstack/react-router'
import { ApiError, getVersion } from '@/lib/api'
import { isNodeReady, summarizePod } from '@/lib/k8s/pods'
import { useNodes, useNodesLive, usePods, usePodsLive } from '@/lib/k8s/queries'
import { useClusterInfo } from '@/lib/queries'
import { formatBytes, formatCpu, metricsProblem, nodeRows, useNodeMetrics } from '@/lib/k8s/metrics'

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
        <UsageTiles />
      </div>

      <Health />

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
  const { total, running, failing } = useMemo(() => {
    const summaries = (pods.data?.items ?? []).map(summarizePod)
    return {
      total: summaries.length,
      running: summaries.filter((s) => s.status === 'Running').length,
      failing: summaries.filter((s) => s.severity === 'critical').length,
    }
  }, [pods.data])
  if (useClusterDown()) {
    return <StatTile label={t('overview.pods')} status="critical" value="—" hint={t('cluster.unreachable')} />
  }
  if (pods.isError) {
    return <StatTile label={t('overview.pods')} value="—" hint={errorHint(t, pods.error)} />
  }
  return (
    <StatTile
      label={t('overview.pods')}
      status={!pods.data ? 'unknown' : failing > 0 ? 'critical' : 'ok'}
      value={pods.data ? `${running}/${total}` : '…'}
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

/** Indicadores de saúde; o que não puder ser lido conta como vazio, com aviso. */
function Health() {
  const { t } = useTranslation()
  const pods = usePods('')
  const nodes = useNodes()
  if (useClusterDown()) return null
  const failed = [pods.isError && `${t('kinds.pods')}: ${errorHint(t, pods.error)}`, nodes.isError && `${t('kinds.nodes')}: ${errorHint(t, nodes.error)}`]
    .filter(Boolean)
    .join(' · ')
  return (
    <HealthPanel
      pods={pods.isError ? [] : pods.data?.items}
      nodes={nodes.isError ? [] : nodes.data?.items}
      error={failed || undefined}
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

/** CPU e memória em uso no cluster, sobre a capacidade alocável dos nós. */
function UsageTiles() {
  const { t } = useTranslation()
  const nodes = useNodes()
  const metrics = useNodeMetrics()
  const rows = useMemo(() => nodeRows(nodes.data?.items ?? [], metrics.data?.items ?? [], []), [nodes.data, metrics.data])
  if (metrics.isError) {
    const hint = t(`overview.metrics.${metricsProblem(metrics.error)}`)
    return (
      <>
        <StatTile label={t('overview.cpu')} value="—" hint={hint} />
        <StatTile label={t('overview.memory')} value="—" hint={hint} />
      </>
    )
  }
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0)
  const cpu = sum((r) => r.cpu)
  const cpuAlloc = sum((r) => r.cpuAllocatable)
  const mem = sum((r) => r.memory)
  const memAlloc = sum((r) => r.memoryAllocatable)
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)
  const status = (a: number, b: number) => (!metrics.data || b === 0 ? 'unknown' : a / b >= 0.9 ? 'critical' : a / b >= 0.75 ? 'warn' : 'ok')
  const link = (text: string) => (
    <Link to="/metrics" className="hover:text-foreground">
      {text}
    </Link>
  )
  return (
    <>
      <StatTile
        label={t('overview.cpu')}
        status={status(cpu, cpuAlloc)}
        value={metrics.data ? `${pct(cpu, cpuAlloc)}%` : '…'}
        hint={metrics.data ? link(t('overview.usageOf', { used: formatCpu(cpu), total: formatCpu(cpuAlloc) })) : undefined}
      />
      <StatTile
        label={t('overview.memory')}
        status={status(mem, memAlloc)}
        value={metrics.data ? `${pct(mem, memAlloc)}%` : '…'}
        hint={metrics.data ? link(t('overview.usageOf', { used: formatBytes(mem), total: formatBytes(memAlloc) })) : undefined}
      />
    </>
  )
}
