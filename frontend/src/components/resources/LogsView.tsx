import { ArrowDownToLine, Download, History, RotateCcw, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { MAX_LINES, useLogStream, type LogOptions } from '@/lib/k8s/logs'
import type { K8sObject, Pod } from '@/lib/k8s/types'
import { cn } from '@/lib/utils'

const TAILS = [100, 500, 2000, 0]

/** Logs dos containers de um pod: ao vivo, anteriores, busca e download. */
export function LogsView({ pod }: { pod: K8sObject }) {
  const { t } = useTranslation()
  const spec = pod.spec as { containers?: { name: string }[]; initContainers?: { name: string }[] }
  const containers = [
    ...(spec.containers ?? []).map((c) => ({ value: c.name, label: c.name })),
    ...(spec.initContainers ?? []).map((c) => ({ value: c.name, label: `${c.name} (init)` })),
  ]
  const statuses = [
    ...((pod.status?.containerStatuses as Pod['status']['containerStatuses']) ?? []),
    ...((pod.status?.initContainerStatuses as Pod['status']['containerStatuses']) ?? []),
  ]
  const [container, setContainer] = useState(containers[0]?.value ?? '')
  const [previous, setPrevious] = useState(false)
  const [tail, setTail] = useState(500)
  const [follow, setFollow] = useState(true)
  const restarts = statuses.find((s) => s.name === container)?.restartCount ?? 0

  const opts: LogOptions = {
    namespace: pod.metadata.namespace ?? '',
    pod: pod.metadata.name,
    container,
    previous,
    tail,
    follow,
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {containers.length > 1 && (
          <Combobox
            label={t('logs.container')}
            value={container}
            options={containers}
            onChange={setContainer}
            className="w-56"
          />
        )}
        <Toggle pressed={previous} onClick={() => setPrevious((p) => !p)} icon={<History />}>
          {t('logs.previous')}
        </Toggle>
        <Toggle pressed={follow && !previous} disabled={previous} onClick={() => setFollow((f) => !f)} icon={<ArrowDownToLine />}>
          {t('logs.follow')}
        </Toggle>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          {t('logs.tail')}
          <select
            className="h-7 rounded-md border bg-surface px-1 text-foreground"
            value={tail}
            onChange={(e) => setTail(Number(e.target.value))}
          >
            {TAILS.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t('logs.all') : n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {restarts > 0 && !previous && (
        <p className="text-xs text-warn">
          {t('logs.restarted', { count: restarts })}{' '}
          <button type="button" className="underline" onClick={() => setPrevious(true)}>
            {t('logs.seePrevious')}
          </button>
        </p>
      )}
      {container && <LogPanel key={JSON.stringify(opts)} opts={opts} />}
    </div>
  )
}

function Toggle({
  pressed,
  onClick,
  icon,
  disabled,
  children,
}: {
  pressed: boolean
  onClick: () => void
  icon: ReactNode
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Button size="sm" variant={pressed ? 'primary' : 'outline'} aria-pressed={pressed} onClick={onClick} disabled={disabled}>
      {icon}
      {children}
    </Button>
  )
}

function highlight(text: string, term: string): ReactNode {
  if (!term) return text
  const out: ReactNode[] = []
  const lower = text.toLowerCase()
  let i = 0
  for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, i)) {
    out.push(text.slice(i, at), <mark key={at} className="rounded-sm bg-warn/30 text-foreground">{text.slice(at, at + term.length)}</mark>)
    i = at + term.length
  }
  out.push(text.slice(i))
  return out
}

function LogPanel({ opts }: { opts: LogOptions }) {
  const { t } = useTranslation()
  const { lines, state, error, retry } = useLogStream(opts)
  const [filter, setFilter] = useState('')
  const [showTime, setShowTime] = useState(false)
  const [wrap, setWrap] = useState(true)
  const [stuck, setStuck] = useState(true)
  const box = useRef<HTMLDivElement>(null)

  const term = filter.trim().toLowerCase()
  const visible = useMemo(() => (term ? lines.filter((l) => l.text.toLowerCase().includes(term)) : lines), [lines, term])

  // Acompanha o fim enquanto o usuário não rolou para cima.
  useEffect(() => {
    if (stuck && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [visible, stuck])

  const onScroll = () => {
    const el = box.current
    if (el) setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  const download = () => {
    const body = lines.map((l) => (l.time ? `${l.time} ${l.text}` : l.text)).join('\n') + '\n'
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${opts.pod}-${opts.container}${opts.previous ? '-anterior' : ''}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  const friendlyError =
    error && /previous terminated container .* not found/.test(error)
      ? t('logs.noPrevious')
      : error && /waiting to start|ContainerCreating|PodInitializing/.test(error)
        ? t('logs.notStarted')
        : error

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-7 w-64 items-center gap-2 rounded-md border bg-surface px-2 text-muted focus-within:border-accent">
          <Search className="size-3.5" aria-hidden />
          <input
            className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-subtle"
            placeholder={t('logs.search')}
            aria-label={t('logs.search')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        {term && <span className="text-xs text-muted">{t('logs.matches', { count: visible.length })}</span>}
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={showTime} onChange={(e) => setShowTime(e.target.checked)} />
          {t('logs.timestamps')}
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
          {t('logs.wrap')}
        </label>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted" role="status">
          <span
            className={cn(
              'size-2 rounded-full',
              state === 'streaming' && opts.follow && !opts.previous ? 'animate-pulse bg-ok' : state === 'error' ? 'bg-critical' : 'bg-subtle',
            )}
            aria-hidden
          />
          {t(`logs.state.${state === 'streaming' && (!opts.follow || opts.previous) ? 'loaded' : state}`)} ·{' '}
          {t('logs.lines', { count: lines.length })}
          {lines.length >= MAX_LINES && ` (${t('logs.capped', { max: MAX_LINES })})`}
        </span>
        <Button size="sm" onClick={download} disabled={lines.length === 0}>
          <Download />
          {t('logs.download')}
        </Button>
      </div>

      {state === 'error' ? (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-critical/40 bg-critical/5 p-3">
          <span className="flex-1">{friendlyError}</span>
          <Button size="sm" onClick={retry}>
            <RotateCcw />
            {t('logs.retry')}
          </Button>
        </div>
      ) : (
        <div className="relative">
          <div
            ref={box}
            onScroll={onScroll}
            className="h-[60vh] overflow-auto rounded-lg border bg-surface p-3 font-mono text-xs leading-relaxed"
            role="log"
            aria-label={t('logs.region', { container: opts.container })}
          >
            {visible.length === 0 ? (
              <p className="text-subtle">
                {state === 'connecting' ? t('logs.state.connecting') : term ? t('logs.noMatches') : t('logs.empty')}
              </p>
            ) : (
              visible.map((l) => (
                <div key={l.id} className={wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre'}>
                  {showTime && l.time && <span className="mr-2 text-subtle select-none">{l.time.replace('T', ' ').slice(0, 23)}</span>}
                  {highlight(l.text, term)}
                </div>
              ))
            )}
          </div>
          {!stuck && (
            <Button
              size="sm"
              variant="primary"
              className="absolute right-4 bottom-4"
              onClick={() => {
                setStuck(true)
                if (box.current) box.current.scrollTop = box.current.scrollHeight
              }}
            >
              <ArrowDownToLine />
              {t('logs.toEnd')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
