import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import { ApiError } from '@/lib/api'
import { HISTORY_RANGES, prepare, scopeFromId, scopeId, stats, useHistory, useHistoryStatus, type HistoryRange, type HistoryScope } from '@/lib/k8s/history'
import { formatBytes, formatCpu } from '@/lib/k8s/metrics'
import { cn } from '@/lib/utils'
import { TimeSeriesChart, type ChartSeries } from './TimeSeriesChart'

// Colunas dos pontos: [ts, cpu, mem, cpuReq, memReq, cpuLim, memLim, cpuCap, memCap].
const COL = { cpu: 0, mem: 1, cpuReq: 2, memReq: 3, cpuLim: 4, memLim: 5, cpuCap: 6, memCap: 7 }

interface HistoryPanelProps {
  scope: HistoryScope
  onScope: (s: HistoryScope) => void
  options: ComboboxOption[]
}

/** Histórico de CPU e memória do escopo escolhido (coletor embutido ou Prometheus). */
export function HistoryPanel({ scope, onScope, options }: HistoryPanelProps) {
  const { t } = useTranslation()
  const [range, setRange] = useState<HistoryRange>('1h')
  const status = useHistoryStatus()
  const state = status.data?.state
  const prom = status.data?.prometheus
  const fromProm = status.data?.source === 'prometheus'
  const ready = state === 'ok' || state === 'starting'
  const history = useHistory(scope, range, ready)

  const charts = useMemo(() => {
    if (!history.data || history.data.points.length === 0) return null
    const p = prepare(history.data)
    const hasCap = scope.kind === 'cluster' || scope.kind === 'node'
    const make = (use: number, req: number, lim: number, cap: number): ChartSeries[] => {
      const s: ChartSeries[] = [
        { label: t('history.used'), values: p.col(use), color: '--accent', fill: true },
        { label: t('history.requests'), values: p.col(req), color: '--warn', dashed: true },
      ]
      if (hasCap) s.push({ label: t('history.capacity'), values: p.col(cap), color: '--muted', dashed: true })
      else if (p.col(lim).some((v) => v)) s.push({ label: t('history.limits'), values: p.col(lim), color: '--critical', dashed: true })
      return s
    }
    return {
      ts: p.ts,
      cpu: make(COL.cpu, COL.cpuReq, COL.cpuLim, COL.cpuCap),
      mem: make(COL.mem, COL.memReq, COL.memLim, COL.memCap),
      cpuStats: stats(p.col(COL.cpu)),
      memStats: stats(p.col(COL.mem)),
    }
  }, [history.data, scope.kind, t])

  const forbidden = history.error instanceof ApiError && history.error.status === 403
  const summary = (s: ReturnType<typeof stats>, f: (v: number) => string) =>
    s ? t('history.summary', { avg: f(s.avg), max: f(s.max), last: f(s.last) }) : ''

  return (
    <section className="space-y-3 rounded-lg border bg-surface p-3" aria-label={t('history.title')}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto font-semibold">{t('history.title')}</h2>
        <Combobox
          label={t('history.scope')}
          value={scopeId(scope)}
          options={options}
          onChange={(v) => onScope(scopeFromId(v))}
          searchPlaceholder={t('history.searchScope')}
          className="w-72"
        />
        <div role="radiogroup" aria-label={t('history.range')} className="flex rounded-md border p-0.5">
          {HISTORY_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={range === r}
              onClick={() => setRange(r)}
              className={cn('rounded px-2 py-1 font-mono text-xs', range === r ? 'bg-accent/15 text-foreground' : 'text-muted hover:text-foreground')}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {status.data && state !== 'disabled' && (
        <p className="-mt-2 text-xs text-muted">
          {fromProm ? t('history.source.prometheus', { target: prom?.target ?? '' }) : t('history.source.collector')}
        </p>
      )}
      {!fromProm && (prom?.state === 'incomplete' || prom?.state === 'unreachable') && (
        <p className="text-xs text-muted">
          {t(`history.prometheus.${prom.state}`, { target: prom.target ?? '', missing: prom.missing?.join(', ') ?? '', error: prom.error ?? '' })}
        </p>
      )}
      {state && !ready && <p className="text-muted">{t(`history.state.${state}`, { error: status.data?.error ?? '' })}</p>}
      {ready && forbidden && <p className="text-muted">{t('history.forbidden')}</p>}
      {ready && !forbidden && history.isError && <p className="text-critical">{history.error.message}</p>}
      {ready && history.data && !charts && <p className="text-muted">{fromProm ? t('history.emptyPrometheus') : t('history.empty', { interval: status.data?.interval ?? '30s' })}</p>}
      {charts && (
        <div className="grid gap-3 xl:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs text-muted">CPU</h3>
            <TimeSeriesChart title={t('history.cpuTitle')} ts={charts.ts} series={charts.cpu} format={formatCpu} summary={summary(charts.cpuStats, formatCpu)} />
          </div>
          <div>
            <h3 className="mb-1 text-xs text-muted">{t('metrics.col.memory')}</h3>
            <TimeSeriesChart title={t('history.memoryTitle')} ts={charts.ts} series={charts.mem} format={formatBytes} summary={summary(charts.memStats, formatBytes)} />
          </div>
        </div>
      )}
    </section>
  )
}
