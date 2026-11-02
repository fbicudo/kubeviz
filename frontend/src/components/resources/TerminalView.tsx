import { Plug, PlugZap, RotateCcw, TerminalSquare } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import type { Shell } from '@/lib/k8s/exec'
import type { K8sObject } from '@/lib/k8s/types'
import type { ExecState } from './ExecTerminal'

// O xterm.js só é baixado quando alguém abre um terminal.
const ExecTerminal = lazy(() => import('./ExecTerminal'))

/** Terminal no container: conexão só por clique explícito. */
export function TerminalView({ pod }: { pod: K8sObject }) {
  const { t } = useTranslation()
  const containers = ((pod.spec as { containers?: { name: string }[] }).containers ?? []).map((c) => ({ value: c.name, label: c.name }))
  const [container, setContainer] = useState(containers[0]?.value ?? '')
  const [shell, setShell] = useState<Shell>('auto')
  const [session, setSession] = useState(0)
  const [state, setState] = useState<ExecState | 'idle'>('idle')
  const [message, setMessage] = useState<string>()
  const running = pod.status?.phase === 'Running'

  const connect = () => {
    setMessage(undefined)
    setState('connecting')
    setSession((s) => s + 1)
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {containers.length > 1 && (
          <Combobox label={t('logs.container')} value={container} options={containers} onChange={setContainer} className="w-56" disabled={state === 'open'} />
        )}
        <label className="flex items-center gap-1.5 text-xs text-muted">
          {t('terminal.shell')}
          <select
            className="h-7 rounded-md border bg-surface px-1 text-foreground"
            value={shell}
            onChange={(e) => setShell(e.target.value as Shell)}
            disabled={state === 'open'}
          >
            <option value="auto">{t('terminal.shellAuto')}</option>
            <option value="sh">sh</option>
            <option value="bash">bash</option>
          </select>
        </label>
        {state === 'open' || state === 'connecting' ? (
          <Button size="sm" onClick={() => setState('idle')}>
            <Plug />
            {t('terminal.disconnect')}
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={connect} disabled={!running || !container}>
            {state === 'closed' ? <RotateCcw /> : <PlugZap />}
            {state === 'closed' ? t('terminal.reconnect') : t('terminal.connect')}
          </Button>
        )}
        <span className="ml-auto text-xs text-muted" role="status">
          {state !== 'idle' && t(`terminal.state.${state}`)}
        </span>
      </div>

      {!running && <p className="text-xs text-warn">{t('terminal.notRunning')}</p>}
      {message && state === 'closed' && <p className="text-xs text-muted">{message}</p>}

      {state === 'idle' ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-surface text-center text-muted">
          <TerminalSquare className="size-6" aria-hidden />
          <p>{t('terminal.intro', { container })}</p>
          <p className="text-xs text-subtle">{t('terminal.audit')}</p>
        </div>
      ) : (
        <Suspense fallback={<p className="h-[60vh] rounded-lg border p-4 text-muted">{t('terminal.loading')}</p>}>
          <ExecTerminal
            key={session}
            target={{ namespace: pod.metadata.namespace ?? '', pod: pod.metadata.name, container, shell }}
            onState={(s, m) => {
              setState(s)
              if (m) setMessage(m)
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
