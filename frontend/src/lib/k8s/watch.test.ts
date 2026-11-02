import { describe, expect, it } from 'vitest'
import type { List, Table } from './types'
import { applyListEvents, applyTableEvents, applyToList, applyToTable, readEvents, slim, type WatchEvent } from './watch'

function streamOf(chunks: string[]) {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((s) => c.enqueue(enc.encode(s)))
      c.close()
    },
  })
}

async function collect(chunks: string[]) {
  const out: WatchEvent[] = []
  for await (const ev of readEvents(streamOf(chunks))) out.push(ev)
  return out
}

describe('readEvents', () => {
  it('junta eventos partidos entre pedaços e separa eventos do mesmo pedaço', async () => {
    const evs = await collect([
      '{"type":"ADDED","object":{"metadata":{"na',
      'me":"a"}}}\n{"type":"MODIFIED","object":{"metadata":{"name":"a"}}}\n{"type":"DEL',
      'ETED","object":{"metadata":{"name":"a"}}}',
    ])
    expect(evs.map((e) => e.type)).toEqual(['ADDED', 'MODIFIED', 'DELETED'])
  })

  it('aceita caracteres multibyte partidos entre pedaços', async () => {
    const bytes = new TextEncoder().encode('{"type":"ADDED","object":{"metadata":{"name":"ação"}}}\n')
    const cut = bytes.indexOf(0xc3) + 1 // corta no meio do "ç"
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut))
        c.enqueue(bytes.slice(cut))
        c.close()
      },
    })
    const evs: WatchEvent[] = []
    for await (const ev of readEvents(stream)) evs.push(ev)
    expect((evs[0].object as { metadata: { name: string } }).metadata.name).toBe('ação')
  })
})

type Obj = { metadata: { uid: string; name: string; resourceVersion?: string }; v?: number }
const obj = (uid: string, rv: string, v = 0): Obj => ({ metadata: { uid, name: uid, resourceVersion: rv }, v })

describe('applyToList', () => {
  const base: List<Obj> = { kind: 'List', metadata: { resourceVersion: '10' }, items: [obj('a', '5'), obj('b', '6')] }

  it('adiciona, atualiza e remove pelo uid, avançando o resourceVersion', () => {
    let l = applyToList(base, { type: 'ADDED', object: obj('c', '11') })
    expect(l.items.map((i) => i.metadata.uid)).toEqual(['a', 'b', 'c'])
    l = applyToList(l, { type: 'MODIFIED', object: obj('a', '12', 7) })
    expect(l.items.find((i) => i.metadata.uid === 'a')?.v).toBe(7)
    l = applyToList(l, { type: 'DELETED', object: obj('b', '13') })
    expect(l.items.map((i) => i.metadata.uid)).toEqual(['a', 'c'])
    expect(l.metadata.resourceVersion).toBe('13')
  })

  it('BOOKMARK só avança o resourceVersion', () => {
    const l = applyToList(base, { type: 'BOOKMARK', object: { metadata: { uid: '', name: '', resourceVersion: '99' } } })
    expect(l.items).toBe(base.items)
    expect(l.metadata.resourceVersion).toBe('99')
  })
})

describe('applyToTable', () => {
  const row = (uid: string, ready: string, rv = '1') => ({
    cells: [uid, ready],
    object: { metadata: { uid, name: uid, creationTimestamp: '', resourceVersion: rv } },
  })
  const base: Table = {
    kind: 'Table',
    metadata: { resourceVersion: '10' },
    columnDefinitions: [
      { name: 'Name', type: 'string', priority: 0 },
      { name: 'Ready', type: 'string', priority: 0 },
    ],
    rows: [row('web', '1/2')],
  }
  const ev = (type: WatchEvent['type'], r: ReturnType<typeof row>): WatchEvent<Table> => ({
    type,
    object: { ...base, columnDefinitions: [], rows: [r] },
  })

  it('mantém as colunas e aplica linhas de cada evento', () => {
    let t = applyToTable(base, ev('MODIFIED', row('web', '2/2', '11')))
    expect(t.columnDefinitions).toHaveLength(2)
    expect(t.rows[0].cells[1]).toBe('2/2')
    t = applyToTable(t, ev('ADDED', row('api', '0/1', '12')))
    expect(t.rows.map((r) => r.cells[0])).toEqual(['web', 'api'])
    t = applyToTable(t, ev('DELETED', row('web', '2/2', '13')))
    expect(t.rows.map((r) => r.cells[0])).toEqual(['api'])
    expect(t.metadata.resourceVersion).toBe('13')
  })
})

describe('lotes de eventos', () => {
  it('aplica uma rajada em lote, rápido e na ordem certa', () => {
    const n = 5000
    const list: List<Obj> = { kind: 'List', metadata: { resourceVersion: '1' }, items: Array.from({ length: n }, (_, i) => obj(`p${i}`, '1')) }
    const events: WatchEvent<Obj>[] = [
      // 500 excluídos, 500 alterados e 500 novos (como ao escalar deployments)
      ...Array.from({ length: 500 }, (_, i) => ({ type: 'DELETED' as const, object: obj(`p${i}`, '2') })),
      ...Array.from({ length: 500 }, (_, i) => ({ type: 'MODIFIED' as const, object: obj(`p${1000 + i}`, '3', 1) })),
      ...Array.from({ length: 500 }, (_, i) => ({ type: 'ADDED' as const, object: obj(`novo${i}`, '4') })),
      { type: 'BOOKMARK', object: { metadata: { uid: '', name: '', resourceVersion: '9' } } },
    ]
    const t0 = performance.now()
    const out = applyListEvents(list, events)
    // Aplicar evento a evento custava linhas × eventos (segundos com 5.000 pods).
    expect(performance.now() - t0).toBeLessThan(200)
    expect(out.items).toHaveLength(n)
    expect(out.items[0].metadata.uid).toBe('p500')
    expect(out.items[500].v).toBe(1)
    expect(out.items.at(-1)?.metadata.uid).toBe('novo499')
    expect(out.metadata.resourceVersion).toBe('9')
    // Excluir e recriar no mesmo lote: o objeto novo fica.
    const again = applyListEvents(out, [
      { type: 'DELETED', object: obj('p600', '10') },
      { type: 'ADDED', object: obj('p600', '11', 2) },
    ])
    expect(again.items.filter((i) => i.metadata.uid === 'p600')).toEqual([obj('p600', '11', 2)])
    // Lote vazio não cria uma lista nova.
    expect(applyListEvents(out, []).items).toBe(out.items)
  })

  it('listas grandes descartam os managedFields', () => {
    const pod = { metadata: { uid: 'a', name: 'a', managedFields: [{ manager: 'kubelet' }] } }
    expect(slim(pod).metadata).toEqual({ uid: 'a', name: 'a' })
    const list: List<Obj> = { kind: 'List', metadata: { resourceVersion: '1' }, items: [] }
    const withManaged = { metadata: { uid: 'b', name: 'b', resourceVersion: '2', managedFields: [{}] } } as Obj
    expect(applyListEvents(list, [{ type: 'ADDED', object: withManaged }], true).items[0].metadata).not.toHaveProperty('managedFields')
    const table: Table = { kind: 'Table', metadata: { resourceVersion: '1' }, columnDefinitions: [], rows: [] }
    const row = { cells: [], object: { metadata: { uid: 'c', name: 'c', creationTimestamp: '', managedFields: [{}] } } }
    const ev: WatchEvent<Table> = { type: 'ADDED', object: { ...table, rows: [row] } }
    expect(applyTableEvents(table, [ev]).rows[0].object.metadata).not.toHaveProperty('managedFields')
  })
})
