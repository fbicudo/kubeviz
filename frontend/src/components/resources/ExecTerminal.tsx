import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  decodeFrame,
  encodeResize,
  encodeStdin,
  EXEC_PROTOCOLS,
  execUrl,
  exitCode,
  missingExecutable,
  type ExecTarget,
} from '@/lib/k8s/exec'

export type ExecState = 'connecting' | 'open' | 'closed'

interface ExecTerminalProps {
  target: ExecTarget
  onState: (state: ExecState, message?: string) => void
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** Terminal (xterm.js) ligado ao exec do pod por WebSocket. */
export default function ExecTerminal({ target, onState }: ExecTerminalProps) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const onStateRef = useRef(onState)
  useEffect(() => {
    onStateRef.current = onState
  })
  const key = JSON.stringify(target)

  useEffect(() => {
    const tgt = JSON.parse(key) as ExecTarget
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: cssVar('--font-mono') || 'monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: cssVar('--surface'),
        foreground: cssVar('--foreground'),
        cursor: cssVar('--accent'),
        selectionBackground: 'rgba(96, 165, 250, 0.3)',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    fit.fit()
    term.focus()

    const ws = new WebSocket(execUrl(tgt), EXEC_PROTOCOLS)
    ws.binaryType = 'arraybuffer'
    onStateRef.current('connecting')
    let finalMessage: string | undefined

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeResize(term.cols, term.rows))
    }
    ws.onopen = () => {
      onStateRef.current('open')
      sendResize()
    }
    ws.onmessage = (ev) => {
      const f = decodeFrame(ev.data as ArrayBuffer)
      if (f.kind === 'output') term.write(f.data)
      else if (f.kind === 'status') {
        const code = exitCode(f.status)
        const missing = missingExecutable(f.status)
        finalMessage = missing
          ? t('terminal.noShell', { shell: missing })
          : f.status.status === 'Success' || code !== undefined
            ? t('terminal.exited', { code: code ?? 0 })
            : (f.status.message ?? t('terminal.failed'))
      }
    }
    ws.onclose = (ev) => {
      // Sem código 1000, a conexão foi recusada (sem permissão, shell inexistente…).
      if (!finalMessage && ev.code !== 1000) finalMessage = t('terminal.refused')
      term.write(`\r\n\x1b[2m[${finalMessage ?? t('terminal.closed')}]\x1b[0m\r\n`)
      onStateRef.current('closed', finalMessage)
    }
    const input = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeStdin(d))
    })
    const observer = new ResizeObserver(() => {
      fit.fit()
      sendResize()
    })
    observer.observe(host.current!)

    return () => {
      observer.disconnect()
      input.dispose()
      ws.onclose = null
      ws.close(1000)
      term.dispose()
    }
  }, [key, t])

  return <div ref={host} className="h-[60vh] overflow-hidden rounded-lg border bg-surface p-2" aria-label={t('terminal.region', { container: target.container })} />
}
