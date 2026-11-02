import { describe, expect, it } from 'vitest'
import { age } from '@/lib/format'
import { isNodeReady, summarizePod } from './pods'
import type { ContainerStatus, Node, Pod } from './types'

function pod(phase: Pod['status']['phase'], containers: Partial<ContainerStatus>[], extra: Partial<Pod['status']> = {}): Pod {
  return {
    metadata: { name: 'p', uid: 'u', creationTimestamp: '2026-11-02T00:00:00Z' },
    spec: { containers: containers.map((_, i) => ({ name: `c${i}` })) },
    status: {
      phase,
      containerStatuses: containers.map((c, i) => ({ name: `c${i}`, ready: false, restartCount: 0, ...c })),
      ...extra,
    },
  }
}

describe('summarizePod', () => {
  it('Running com todos os containers prontos', () => {
    const s = summarizePod(pod('Running', [{ ready: true, state: { running: {} } }, { ready: true, state: { running: {} } }]))
    expect(s).toEqual({ status: 'Running', severity: 'ok', ready: 2, total: 2, restarts: 0 })
  })

  it('Running com container não pronto vira aviso', () => {
    const s = summarizePod(pod('Running', [{ ready: true, state: { running: {} } }, { ready: false, state: { running: {} } }]))
    expect(s.severity).toBe('warn')
    expect(s.ready).toBe(1)
  })

  it('CrashLoopBackOff é crítico e soma reinícios', () => {
    const s = summarizePod(
      pod('Running', [{ restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } }, { restartCount: 1, ready: true, state: { running: {} } }]),
    )
    expect(s.status).toBe('CrashLoopBackOff')
    expect(s.severity).toBe('critical')
    expect(s.restarts).toBe(8)
  })

  it('ImagePullBackOff em Pending é crítico', () => {
    expect(summarizePod(pod('Pending', [{ state: { waiting: { reason: 'ImagePullBackOff' } } }])).severity).toBe('critical')
  })

  it('ContainerCreating é aviso', () => {
    const s = summarizePod(pod('Pending', [{ state: { waiting: { reason: 'ContainerCreating' } } }]))
    expect(s).toMatchObject({ status: 'ContainerCreating', severity: 'warn' })
  })

  it('Job concluído aparece como Completed, neutro', () => {
    const s = summarizePod(pod('Succeeded', [{ state: { terminated: { reason: 'Completed', exitCode: 0 } } }]))
    expect(s).toMatchObject({ status: 'Completed', severity: 'unknown' })
  })

  it('término com código de saída sem motivo', () => {
    expect(summarizePod(pod('Failed', [{ state: { terminated: { exitCode: 137 } } }])).status).toBe('ExitCode:137')
  })

  it('containers de inicialização', () => {
    const p = pod('Pending', [{ state: { waiting: { reason: 'PodInitializing' } } }], {
      initContainerStatuses: [{ name: 'init', ready: false, restartCount: 2, state: { waiting: { reason: 'CrashLoopBackOff' } } }],
    })
    p.spec.initContainers = [{ name: 'init' }]
    expect(summarizePod(p)).toMatchObject({ status: 'Init:CrashLoopBackOff', severity: 'critical' })
  })

  it('pod sendo removido', () => {
    const p = pod('Running', [{ ready: true, state: { running: {} } }])
    p.metadata.deletionTimestamp = '2026-11-02T00:01:00Z'
    expect(summarizePod(p).status).toBe('Terminating')
  })

  it('pod despejado usa o motivo do pod', () => {
    expect(summarizePod(pod('Failed', [], { reason: 'Evicted' }))).toMatchObject({ status: 'Evicted', severity: 'critical' })
  })
})

describe('isNodeReady', () => {
  const node = (status: 'True' | 'False'): Node => ({
    metadata: { name: 'n', uid: 'u', creationTimestamp: '' },
    status: { conditions: [{ type: 'MemoryPressure', status: 'False' }, { type: 'Ready', status }] },
  })
  it('lê a condição Ready', () => {
    expect(isNodeReady(node('True'))).toBe(true)
    expect(isNodeReady(node('False'))).toBe(false)
  })
})

describe('age', () => {
  const now = Date.parse('2026-11-02T12:00:00Z')
  it.each([
    ['2026-11-02T11:59:15Z', '45s'],
    ['2026-11-02T11:48:00Z', '12m'],
    ['2026-11-02T07:00:00Z', '5h'],
    ['2026-10-30T12:00:00Z', '3d'],
    ['2024-01-01T00:00:00Z', '2y'],
    [undefined, '—'],
  ])('%s → %s', (ts, want) => {
    expect(age(ts, now)).toBe(want)
  })
})
