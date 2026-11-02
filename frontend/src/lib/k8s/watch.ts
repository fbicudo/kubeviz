// Atualização em tempo real com o watch da API do Kubernetes.
//
// Fluxo: a lista é carregada normalmente (TanStack Query) e traz um
// resourceVersion; a partir dele abre-se um watch (stream de JSON, um evento
// por linha) e cada evento é aplicado ao cache da lista. O watch é refeito
// quando o servidor encerra o stream; se o resourceVersion expirou (410), a
// lista é recarregada. Sem permissão de watch, volta-se à consulta periódica.

import { hashKey, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { sessionKey } from '@/lib/queries'
import type { List, Table } from './types'

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR'

export interface WatchEvent<T = unknown> {
  type: WatchEventType
  object: T
}

interface WithMeta {
  metadata: { uid?: string; name?: string; namespace?: string; resourceVersion?: string }
}

/** Lê um stream NDJSON, tolerando eventos partidos entre pedaços. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<WatchEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) yield JSON.parse(line) as WatchEvent
      }
    }
    const rest = (buffer + decoder.decode()).trim()
    if (rest) yield JSON.parse(rest) as WatchEvent
  } finally {
    reader.releaseLock()
  }
}

const sameObject = (a: WithMeta['metadata'], b: WithMeta['metadata']) =>
  a.uid && b.uid ? a.uid === b.uid : a.name === b.name && a.namespace === b.namespace

/** Aplica um evento a uma lista comum (ex.: PodList). */
export function applyToList<T extends WithMeta>(list: List<T>, ev: WatchEvent<T>): List<T> {
  const rv = ev.object.metadata.resourceVersion ?? list.metadata.resourceVersion
  if (ev.type === 'BOOKMARK') return { ...list, metadata: { ...list.metadata, resourceVersion: rv } }
  const others = list.items.filter((i) => !sameObject(i.metadata, ev.object.metadata))
  const items =
    ev.type === 'DELETED'
      ? others
      : list.items.some((i) => sameObject(i.metadata, ev.object.metadata))
        ? list.items.map((i) => (sameObject(i.metadata, ev.object.metadata) ? ev.object : i))
        : [...list.items, ev.object]
  return { ...list, items, metadata: { ...list.metadata, resourceVersion: rv } }
}

/**
 * Aplica um evento a uma resposta Table. No watch em formato Table, cada
 * evento traz uma Table com a(s) linha(s) do objeto.
 */
export function applyToTable(table: Table, ev: WatchEvent<Table | WithMeta>): Table {
  if (ev.type === 'BOOKMARK') {
    const rv = (ev.object as WithMeta).metadata?.resourceVersion
    return rv ? { ...table, metadata: { ...table.metadata, resourceVersion: rv } } : table
  }
  const incoming = (ev.object as Table).rows ?? []
  let rows = table.rows
  let rv = table.metadata.resourceVersion
  for (const row of incoming) {
    const meta = row.object.metadata
    rv = meta.resourceVersion ?? rv
    const exists = rows.some((r) => sameObject(r.object.metadata, meta))
    if (ev.type === 'DELETED') rows = rows.filter((r) => !sameObject(r.object.metadata, meta))
    else if (exists) rows = rows.map((r) => (sameObject(r.object.metadata, meta) ? row : r))
    else rows = [...rows, row]
  }
  return { ...table, rows, metadata: { ...table.metadata, resourceVersion: rv } }
}

export type LiveState = 'connecting' | 'live' | 'polling'

/** Consultas mantidas por watch; a consulta periódica fica desligada nelas. */
const liveQueries = new Set<string>()

/** Intervalo de consulta: desligado enquanto o watch mantém a lista. */
export const pollUnlessLive =
  (ms: number) =>
  (query: { queryHash: string }): number | false =>
    liveQueries.has(query.queryHash) ? false : ms

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })

interface UseWatchOptions<T> {
  queryKey: QueryKey
  /** Caminho da coleção, já com o prefixo /api/k8s. */
  path: string
  accept?: string
  /** Só inicia depois que a lista carregou (precisa do resourceVersion). */
  enabled: boolean
  apply: (data: T, ev: WatchEvent) => T
  resourceVersion: (data: T) => string | undefined
}

/** Mantém a lista em `queryKey` atualizada por watch. */
export function useWatch<T>({ queryKey, path, accept, enabled, apply, resourceVersion }: UseWatchOptions<T>): LiveState {
  const qc = useQueryClient()
  const key = hashKey(queryKey)
  // Estado associado à chave: ao trocar de lista, não herda o "ao vivo" da anterior.
  const [current, setCurrent] = useState<{ key: string; state: LiveState }>({ key, state: 'connecting' })

  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController()
    const { signal } = abort
    const qk = JSON.parse(key) as QueryKey
    const setState = (state: LiveState) => {
      if (state === 'live') liveQueries.add(key)
      else liveQueries.delete(key)
      setCurrent({ key, state })
    }

    void (async () => {
      let backoff = 1000
      while (!signal.aborted) {
        const data = qc.getQueryData<T>(qk)
        const rv = data ? resourceVersion(data) : undefined
        if (!rv) {
          // Sem resourceVersion não há como acompanhar sem perder eventos.
          setState('polling')
          return
        }
        const sep = path.includes('?') ? '&' : '?'
        const url = `${path}${sep}watch=1&allowWatchBookmarks=true&timeoutSeconds=600&resourceVersion=${encodeURIComponent(rv)}`
        try {
          const res = await fetch(url, { signal, headers: { Accept: accept ?? 'application/json' } })
          if (res.status === 401) {
            void qc.invalidateQueries({ queryKey: sessionKey })
            return
          }
          if (res.status === 403 || res.status === 405) {
            // Pode listar, mas não acompanhar: volta à consulta periódica.
            setState('polling')
            return
          }
          if (!res.ok || !res.body) throw new Error(`watch: HTTP ${res.status}`)
          setState('live')
          backoff = 1000
          for await (const ev of readEvents(res.body)) {
            if (ev.type === 'ERROR') {
              // 410 Gone: resourceVersion expirou; recarrega a lista e recomeça.
              await qc.refetchQueries({ queryKey: qk, exact: true })
              break
            }
            qc.setQueryData<T>(qk, (old) => (old ? apply(old, ev) : old))
          }
          // Stream encerrado pelo servidor (timeout): reconecta em seguida.
        } catch {
          if (signal.aborted) return
          setState('connecting')
          await sleep(backoff, signal)
          backoff = Math.min(backoff * 2, 30_000)
        }
      }
    })()

    return () => {
      abort.abort()
      liveQueries.delete(key)
    }
  }, [qc, key, path, accept, enabled, apply, resourceVersion])

  return enabled && current.key === key ? current.state : 'connecting'
}

// Funções estáveis (fora dos componentes) para não reiniciar o watch a cada render.
export const listResourceVersion = <T,>(l: List<T>) => l.metadata.resourceVersion
export const tableResourceVersion = (t: Table) => t.metadata.resourceVersion
export const applyListEvent = <T extends WithMeta>(l: List<T>, ev: WatchEvent) => applyToList(l, ev as WatchEvent<T>)
export const applyTableEvent = (t: Table, ev: WatchEvent) => applyToTable(t, ev as WatchEvent<Table | WithMeta>)
