// Logs de containers pela API (pods/log), em stream.
//
// Sempre pede timestamps=true: o horário de cada linha permite reconectar
// (sinceTime) sem duplicar linhas e é exibido só se o usuário quiser.

import { useEffect, useRef, useState } from 'react'

/** Máximo de linhas mantidas na tela; as mais antigas são descartadas. */
export const MAX_LINES = 5000

export interface LogLine {
  /** Sequencial, estável entre renders (chave da lista). */
  id: number
  time?: string
  text: string
}

// Sequências de controle ANSI (cores, cursor) que tornam o texto ilegível.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

export const stripAnsi = (s: string) => s.replace(ANSI, '')

/** Separa o horário RFC3339 que a API coloca no início de cada linha. */
export function splitTimestamp(line: string): { time?: string; text: string } {
  const sp = line.indexOf(' ')
  const head = sp > 0 ? line.slice(0, sp) : ''
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(head)) return { time: head, text: line.slice(sp + 1) }
  return { text: line }
}

/** Acrescenta linhas respeitando o limite (descarta as mais antigas). */
export function appendLines(current: LogLine[], incoming: LogLine[], max = MAX_LINES): LogLine[] {
  const all = current.concat(incoming)
  return all.length > max ? all.slice(all.length - max) : all
}

export interface LogOptions {
  namespace: string
  pod: string
  container: string
  previous: boolean
  /** Linhas iniciais; 0 = todas. */
  tail: number
  follow: boolean
}

export type LogState = 'connecting' | 'streaming' | 'ended' | 'error'

export function logUrl(o: LogOptions, sinceTime?: string): string {
  const p = new URLSearchParams({ container: o.container, timestamps: 'true' })
  if (o.previous) p.set('previous', 'true')
  else if (o.follow) p.set('follow', 'true')
  if (sinceTime) p.set('sinceTime', sinceTime)
  else if (o.tail > 0) p.set('tailLines', String(o.tail))
  return `/api/k8s/api/v1/namespaces/${encodeURIComponent(o.namespace)}/pods/${encodeURIComponent(o.pod)}/log?${p}`
}

/**
 * Lê os logs e, com `follow`, mantém a conexão; se o stream cair (container
 * reiniciou, timeout), reconecta a partir do último horário recebido.
 * Quem usa deve recriar o componente (key) quando as opções mudam, para
 * começar com a tela limpa.
 */
export function useLogStream(opts: LogOptions | null) {
  const [lines, setLines] = useState<LogLine[]>([])
  const [state, setState] = useState<LogState>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = opts ? JSON.stringify(opts) : ''
  const seq = useRef(0)

  useEffect(() => {
    if (!key) return
    const o = JSON.parse(key) as LogOptions
    const abort = new AbortController()
    let lastTime: string | undefined
    let lastTextAtTime = new Set<string>()

    const run = async () => {
      let backoff = 1000
      for (;;) {
        try {
          const res = await fetch(logUrl(o, lastTime), { signal: abort.signal })
          if (!res.ok || !res.body) {
            const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
            setError(body.message ?? body.error ?? `HTTP ${res.status}`)
            setState('error')
            return
          }
          setState('streaming')
          backoff = 1000
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { value, done } = await reader.read()
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
            const parts = buffer.split('\n')
            // A última parte pode ser uma linha incompleta; no fim do stream, vale como linha.
            buffer = done ? '' : (parts.pop() ?? '')
            const batch: LogLine[] = []
            for (const raw of parts) {
              if (done && raw === '') continue
              const { time, text } = splitTimestamp(raw)
              const clean = stripAnsi(text)
              // Ao reconectar com sinceTime, a API repete as linhas do mesmo segundo.
              if (time && time === lastTime && lastTextAtTime.has(clean)) continue
              if (time && time !== lastTime) {
                lastTime = time
                lastTextAtTime = new Set()
              }
              if (time) lastTextAtTime.add(clean)
              batch.push({ id: ++seq.current, time, text: clean })
            }
            if (batch.length) setLines((cur) => appendLines(cur, batch))
            if (done) break
          }
          if (!o.follow || o.previous) {
            setState('ended')
            return
          }
          // Stream encerrado pelo servidor (container reiniciou): reconecta.
          setState('connecting')
          await new Promise((r) => setTimeout(r, backoff))
        } catch {
          if (abort.signal.aborted) return
          setState('connecting')
          await new Promise((r) => setTimeout(r, backoff))
          backoff = Math.min(backoff * 2, 15_000)
        }
        if (abort.signal.aborted) return
      }
    }
    void run()
    return () => abort.abort()
  }, [key, attempt])

  const retry = () => {
    setLines([])
    setError(null)
    setState('connecting')
    setAttempt((a) => a + 1)
  }
  return { lines, state, error, retry, clear: () => setLines([]) }
}
