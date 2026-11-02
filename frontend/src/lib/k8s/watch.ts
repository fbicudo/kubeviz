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
  metadata: { uid?: string; name?: string; namespace?: string; resourceVersion?: string; managedFields?: unknown }
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

interface Meta {
  uid?: string
  name?: string
  namespace?: string
  resourceVersion?: string
  managedFields?: unknown
}

/** Identidade do objeto: uid, ou namespace/nome se faltar o uid. */
const keyOf = (m: Meta) => m.uid || `${m.namespace ?? ''}/${m.name ?? ''}`

/**
 * Remove os managedFields, que são a maior parte do tamanho de cada objeto
 * nas listas (cerca de 3/4 num pod). A página de detalhe busca o objeto
 * completo.
 */
export function slim<T extends { metadata?: Meta }>(o: T): T {
  if (o.metadata?.managedFields) delete o.metadata.managedFields
  return o
}

/**
 * Aplica mudanças a linhas mantendo a ordem: altera no lugar, acrescenta no
 * fim, remove as excluídas. Custo proporcional a linhas + mudanças, com um
 * índice por objeto (aplicar evento a evento custaria linhas × mudanças).
 */
function mergeRows<R>(rows: R[], changes: { deleted: boolean; row: R }[], metaOf: (r: R) => Meta): R[] {
  if (changes.length === 0) return rows
  const out: (R | undefined)[] = rows.slice()
  const index = new Map<string, number>()
  rows.forEach((r, i) => index.set(keyOf(metaOf(r)), i))
  for (const { deleted, row } of changes) {
    const key = keyOf(metaOf(row))
    const i = index.get(key)
    if (deleted) {
      if (i !== undefined) {
        out[i] = undefined
        index.delete(key)
      }
    } else if (i !== undefined) out[i] = row
    else index.set(key, out.push(row) - 1)
  }
  return out.filter((r): r is R => r !== undefined)
}

/** Último resourceVersion de um lote de eventos. */
function lastVersion(events: WatchEvent<WithMeta>[], current?: string): string | undefined {
  let rv = current
  for (const ev of events) rv = ev.object.metadata?.resourceVersion ?? rv
  return rv
}

/** Aplica um lote de eventos a uma lista comum (ex.: PodList). */
export function applyListEvents<T extends WithMeta>(list: List<T>, events: WatchEvent<T>[], slimmed = false): List<T> {
  const changes = events
    .filter((ev) => ev.type === 'ADDED' || ev.type === 'MODIFIED' || ev.type === 'DELETED')
    .map((ev) => ({ deleted: ev.type === 'DELETED', row: slimmed ? slim(ev.object) : ev.object }))
  const items = mergeRows(list.items, changes, (i) => i.metadata)
  const resourceVersion = lastVersion(events, list.metadata.resourceVersion)
  return { ...list, items, metadata: { ...list.metadata, resourceVersion } }
}

/**
 * Aplica um lote de eventos a uma resposta Table. No watch em formato Table,
 * cada evento traz uma Table com a(s) linha(s) do objeto.
 */
export function applyTableEvents(table: Table, events: WatchEvent<Table | WithMeta>[]): Table {
  const changes: { deleted: boolean; row: Table['rows'][number] }[] = []
  let rv = table.metadata.resourceVersion
  for (const ev of events) {
    if (ev.type === 'BOOKMARK') {
      rv = (ev.object as WithMeta).metadata?.resourceVersion ?? rv
      continue
    }
    for (const row of (ev.object as Table).rows ?? []) {
      slim(row.object)
      rv = row.object.metadata.resourceVersion ?? rv
      changes.push({ deleted: ev.type === 'DELETED', row })
    }
  }
  return { ...table, rows: mergeRows(table.rows, changes, (r) => r.object.metadata), metadata: { ...table.metadata, resourceVersion: rv } }
}

/** Aplica um único evento (ver applyListEvents). */
export const applyToList = <T extends WithMeta>(list: List<T>, ev: WatchEvent<T>) => applyListEvents(list, [ev])

/** Aplica um único evento (ver applyTableEvents). */
export const applyToTable = (table: Table, ev: WatchEvent<Table | WithMeta>) => applyTableEvents(table, [ev])

export type LiveState = 'connecting' | 'live' | 'polling'

/** Consultas mantidas por watch; a consulta periódica fica desligada nelas. */
const liveQueries = new Set<string>()

/** Intervalo de consulta: desligado enquanto o watch mantém a lista. */
export const pollUnlessLive =
  (ms: number) =>
  (query: { queryHash: string }): number | false =>
    liveQueries.has(query.queryHash) ? false : ms

/**
 * Eventos que chegam juntos são aplicados de uma vez: uma rajada (500 pods
 * criados, por exemplo) vira poucas atualizações da tela, não uma por evento.
 */
const BATCH_MS = 100

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
  /** Aplica um lote de eventos aos dados. */
  apply: (data: T, events: WatchEvent[]) => T
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
          let pending: WatchEvent[] = []
          let timer: ReturnType<typeof setTimeout> | undefined
          const flush = () => {
            clearTimeout(timer)
            timer = undefined
            if (pending.length === 0 || signal.aborted) return
            const batch = pending
            pending = []
            qc.setQueryData<T>(qk, (old) => (old ? apply(old, batch) : old))
          }
          try {
            for await (const ev of readEvents(res.body)) {
              if (ev.type === 'ERROR') {
                // 410 Gone: resourceVersion expirou; recarrega a lista e recomeça.
                pending = []
                await qc.refetchQueries({ queryKey: qk, exact: true })
                break
              }
              pending.push(ev)
              timer ??= setTimeout(flush, BATCH_MS)
            }
          } finally {
            flush()
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
export const applyListEvent = <T extends WithMeta>(l: List<T>, events: WatchEvent[]) => applyListEvents(l, events as WatchEvent<T>[])
/** Como applyListEvent, sem os managedFields (listas grandes, como a de pods). */
export const applySlimListEvent = <T extends WithMeta>(l: List<T>, events: WatchEvent[]) => applyListEvents(l, events as WatchEvent<T>[], true)
export const applyTableEvent = (t: Table, events: WatchEvent[]) => applyTableEvents(t, events as WatchEvent<Table | WithMeta>[])
