import { describe, expect, it } from 'vitest'
import { prepare, scopeFromId, scopeId, stats } from './history'

describe('histórico', () => {
  it('insere lacunas onde faltam amostras (coletor parado)', () => {
    const row = (ts: number, cpu: number) => [ts, cpu, 0, 0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number, number, number, number]
    const p = prepare({ step: 30, points: [row(0, 1), row(30, 2), row(300, 3), row(330, 4)] })
    expect(p.ts).toEqual([0, 30, 60, 300, 330])
    expect(p.col(0)).toEqual([1, 2, null, 3, 4])
    expect(stats(p.col(0))).toEqual({ avg: 2.5, max: 4, last: 4 })
    expect(stats([null])).toBeNull()
  })

  it('identifica escopos de ida e volta', () => {
    for (const s of [{ kind: 'cluster' }, { kind: 'node', name: 'n1' }, { kind: 'namespace', name: 'demo' }, { kind: 'workload', namespace: 'demo', ownerKind: 'Deployment', name: 'web' }] as const) {
      expect(scopeFromId(scopeId(s))).toEqual(s)
    }
  })
})
