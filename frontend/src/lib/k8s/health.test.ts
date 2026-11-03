import { describe, expect, it } from 'vitest'
import { healthOf } from './health'
import type { Node, Pod } from './types'

const now = Date.parse('2026-11-03T12:00:00Z')
const ago = (min: number) => new Date(now - min * 60_000).toISOString()
const pod = (name: string, status: Pod['status'], created = ago(60)): Pod => ({
  metadata: { name, namespace: 'demo', uid: name, creationTimestamp: created },
  spec: { containers: [{ name: 'c' }] },
  status,
})
const running = (extra: Partial<NonNullable<Pod['status']['containerStatuses']>[number]>) =>
  ({ phase: 'Running', containerStatuses: [{ name: 'c', ready: true, restartCount: 0, state: { running: {} }, ...extra }] }) as Pod['status']

describe('healthOf', () => {
  it('reinícios: só os da última hora ou em CrashLoopBackOff', () => {
    const h = healthOf(
      [
        pod('recente', running({ restartCount: 2, lastState: { terminated: { reason: 'Error', exitCode: 1, finishedAt: ago(10) } } })),
        pod('antigo', running({ restartCount: 5, lastState: { terminated: { reason: 'Error', exitCode: 1, finishedAt: ago(180) } } })),
        pod('loop', running({ restartCount: 9, ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { reason: 'Error', exitCode: 1, finishedAt: ago(120) } } })),
        pod('nunca', running({})),
      ],
      [],
      now,
    )
    expect(h.restarts.map((i) => [i.pod?.metadata.name, i.reason, i.restarts])).toEqual([
      ['recente', 'Error', 2],
      ['loop', 'CrashLoopBackOff', 9],
    ])
  })

  it('OOMKilled no último dia, no estado atual ou no anterior', () => {
    const h = healthOf(
      [
        pod('agora', { phase: 'Running', containerStatuses: [{ name: 'c', ready: false, restartCount: 0, state: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: ago(1) } } }] }),
        pod('ontem', running({ restartCount: 1, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: ago(60 * 30) } } })),
        pod('hoje', running({ restartCount: 1, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: ago(60 * 5) } } })),
      ],
      [],
      now,
    )
    expect(h.oom.map((i) => i.pod?.metadata.name)).toEqual(['agora', 'hoje'])
  })

  it('pendentes há mais de 2 min, com o motivo', () => {
    const h = healthOf(
      [
        pod('sem-no', { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'Insufficient cpu' }] }, ago(5)),
        pod('imagem', { phase: 'Pending', containerStatuses: [{ name: 'c', ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff', message: 'not found' } } }] }, ago(30)),
        pod('novo', { phase: 'Pending' }, ago(1)),
      ],
      [],
      now,
    )
    expect(h.pending.map((i) => [i.pod?.metadata.name, i.reason, i.message])).toEqual([
      ['sem-no', 'Unschedulable', 'Insufficient cpu'],
      ['imagem', 'ImagePullBackOff', 'not found'],
    ])
  })

  it('nós sem Ready=True', () => {
    const node = (name: string, conditions: Node['status']['conditions']): Node => ({ metadata: { name, uid: name, creationTimestamp: ago(999) }, status: { conditions } })
    const h = healthOf(
      [],
      [
        node('ok', [{ type: 'Ready', status: 'True' }]),
        node('caiu', [{ type: 'Ready', status: 'Unknown', reason: 'NodeStatusUnknown', message: 'Kubelet stopped posting node status.', lastTransitionTime: ago(4) }]),
        node('sem-condicao', []),
      ],
      now,
    )
    expect(h.notReady.map((i) => [i.node?.metadata.name, i.reason])).toEqual([
      ['caiu', 'NodeStatusUnknown'],
      ['sem-condicao', 'Unknown'],
    ])
  })
})
