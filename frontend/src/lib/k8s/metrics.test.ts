import { describe, expect, it } from 'vitest'
import { cpuMillis, formatBytes, formatCpu, groupBy, nodeRows, parseQuantity, podReservations, podRows, workloadOf } from './metrics'
import type { Node, Pod } from './types'

const pod = (name: string, ns: string, extra: Partial<Pod['metadata']> = {}, containers: Pod['spec']['containers'] = [], phase: Pod['status']['phase'] = 'Running', nodeName = 'n1'): Pod => ({
  metadata: { name, namespace: ns, uid: `${ns}/${name}`, creationTimestamp: '', ...extra },
  spec: { nodeName, containers },
  status: { phase },
})

describe('quantidades do Kubernetes', () => {
  it('lê CPU e memória em todas as notações', () => {
    expect(cpuMillis('250m')).toBe(250)
    expect(cpuMillis('2')).toBe(2000)
    expect(cpuMillis('1.5')).toBe(1500)
    expect(cpuMillis('123456789n')).toBeCloseTo(123.456789)
    expect(cpuMillis('500u')).toBeCloseTo(0.5)
    expect(parseQuantity('128Mi')).toBe(128 * 2 ** 20)
    expect(parseQuantity('1Gi')).toBe(2 ** 30)
    expect(parseQuantity('2048Ki')).toBe(2 * 2 ** 20)
    expect(parseQuantity('1G')).toBe(1e9)
    expect(parseQuantity('1e3')).toBe(1000)
    expect(parseQuantity(undefined)).toBe(0)
    expect(parseQuantity('lixo')).toBe(0)
  })

  it('formata para leitura', () => {
    expect(formatCpu(152)).toBe('152m')
    expect(formatCpu(1500)).toBe('1.5 CPU')
    expect(formatCpu(4000)).toBe('4 CPU')
    expect(formatCpu(16250)).toBe('16.3 CPU')
    expect(formatBytes(4 * 2 ** 20)).toBe('4.0 MiB')
    expect(formatBytes(1168 * 2 ** 20)).toBe('1.1 GiB')
    expect(formatBytes(512)).toBe('512 B')
  })
})

describe('agregações', () => {
  const web = pod('web-5dd99785c9-abcde', 'demo', {
    labels: { 'pod-template-hash': '5dd99785c9' },
    ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-5dd99785c9', uid: 'rs', controller: true }],
  }, [{ name: 'app', resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '500m', memory: '128Mi' } } }, { name: 'sidecar', resources: { requests: { cpu: '50m' } } }])
  const db = pod('db-0', 'demo', { ownerReferences: [{ apiVersion: 'apps/v1', kind: 'StatefulSet', name: 'db', uid: 'ss', controller: true }] })
  const solto = pod('solto', 'outro')
  const terminado = pod('job-x', 'outro', {}, [{ name: 'c', resources: { requests: { cpu: '1' } } }], 'Succeeded')

  it('acha o workload dono do pod', () => {
    expect(workloadOf(web)).toEqual({ kind: 'Deployment', name: 'web', namespace: 'demo' })
    expect(workloadOf(db)).toEqual({ kind: 'StatefulSet', name: 'db', namespace: 'demo' })
    expect(workloadOf(solto)).toEqual({ kind: 'Pod', name: 'solto', namespace: 'outro' })
    // Pod estático: o "dono" é o nó; cada um conta como ele mesmo.
    const etcd = pod('etcd-kind', 'kube-system', { ownerReferences: [{ apiVersion: 'v1', kind: 'Node', name: 'kind', uid: 'n', controller: true }] })
    expect(workloadOf(etcd)).toEqual({ kind: 'Pod', name: 'etcd-kind', namespace: 'kube-system' })
  })

  it('soma requests e limits dos containers; pods terminados não reservam', () => {
    expect(podReservations(web)).toEqual({ cpuRequests: 150, memoryRequests: 64 * 2 ** 20, cpuLimits: 500, memoryLimits: 128 * 2 ** 20 })
    expect(podReservations(terminado).cpuRequests).toBe(0)
  })

  it('junta uso, reservas e capacidade por pod, namespace e nó', () => {
    const rows = podRows([web, db, solto], [
      { metadata: { name: web.metadata.name, namespace: 'demo' }, timestamp: '', containers: [{ name: 'app', usage: { cpu: '20m', memory: '10Mi' } }, { name: 'sidecar', usage: { cpu: '5m', memory: '2Mi' } }] },
      { metadata: { name: 'db-0', namespace: 'demo' }, timestamp: '', containers: [{ name: 'db', usage: { cpu: '300m', memory: '200Mi' } }] },
    ])
    expect(rows[0]).toMatchObject({ cpu: 25, memory: 12 * 2 ** 20, measured: true })
    expect(rows[2].measured).toBe(false)

    const ns = groupBy(rows, (r) => r.pod.metadata.namespace!)
    expect(ns.find((g) => g.key === 'demo')).toMatchObject({ cpu: 325, pods: 2, cpuRequests: 150 })

    const node: Node = { metadata: { name: 'n1', uid: 'n1', creationTimestamp: '' }, status: { allocatable: { cpu: '4', memory: '8Gi' } } }
    const [n] = nodeRows([node], [{ metadata: { name: 'n1' }, timestamp: '', window: '20s', usage: { cpu: '1200m', memory: '3Gi' } }], rows)
    expect(n).toMatchObject({ cpu: 1200, cpuAllocatable: 4000, memory: 3 * 2 ** 30, memoryAllocatable: 8 * 2 ** 30, cpuRequests: 150, pods: 3, measured: true })
  })
})
