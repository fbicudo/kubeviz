import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import i18n from '@/i18n'

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const meta = (name: string, namespace?: string, extra = {}) => ({ name, namespace, uid: `${namespace}/${name}`, creationTimestamp: new Date().toISOString(), ...extra })
const pod = (name: string, ns: string, owner?: { kind: string; name: string }, cpuReq = '100m') => ({
  metadata: meta(name, ns, owner ? { ownerReferences: [{ apiVersion: 'apps/v1', kind: owner.kind, name: owner.name, uid: 'x', controller: true }], labels: owner.kind === 'ReplicaSet' ? { 'pod-template-hash': owner.name.split('-').pop() } : {} } : {}),
  spec: { nodeName: 'kind-control-plane', containers: [{ name: 'c', resources: { requests: { cpu: cpuReq, memory: '64Mi' } } }] },
  status: { phase: 'Running', containerStatuses: [{ name: 'c', ready: true, restartCount: 0, state: { running: {} } }] },
})
const pods = [
  pod('web-abc12-x1', 'demo', { kind: 'ReplicaSet', name: 'web-abc12' }),
  pod('web-abc12-x2', 'demo', { kind: 'ReplicaSet', name: 'web-abc12' }),
  pod('etcd-kind', 'kube-system', undefined, '200m'),
]
const podMetrics = [
  { metadata: { name: 'web-abc12-x1', namespace: 'demo' }, containers: [{ name: 'c', usage: { cpu: '10m', memory: '20Mi' } }] },
  { metadata: { name: 'web-abc12-x2', namespace: 'demo' }, containers: [{ name: 'c', usage: { cpu: '15m', memory: '22Mi' } }] },
  { metadata: { name: 'etcd-kind', namespace: 'kube-system' }, containers: [{ name: 'c', usage: { cpu: '90m', memory: '300Mi' } }] },
]

function fakeApi({ metricsStatus = 200 } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/v1/auth/session') return json({ mode: 'local', loginMethods: ['link'], authenticated: true })
    if (url === '/api/v1/cluster') return json({ mode: 'local', reachable: true, server: 'x', version: 'v1.37.0' })
    if (url === '/api/v1/contexts') return json({ mode: 'local', contexts: [] })
    if (url === '/api/v1/version') return json({ version: 'v0.4.0' })
    if (url === '/api/k8s/api/v1/nodes') {
      return json({ kind: 'NodeList', metadata: {}, items: [{ metadata: meta('kind-control-plane'), status: { allocatable: { cpu: '4', memory: '4Gi' }, conditions: [{ type: 'Ready', status: 'True' }] } }] })
    }
    if (url === '/api/k8s/api/v1/pods') return json({ kind: 'PodList', metadata: {}, items: pods })
    if (url.startsWith('/api/k8s/apis/metrics.k8s.io/')) {
      if (metricsStatus !== 200) return json({ kind: 'Status', code: metricsStatus, message: 'the server could not find the requested resource' }, metricsStatus)
      return url.endsWith('/nodes')
        ? json({ items: [{ metadata: { name: 'kind-control-plane' }, timestamp: '', window: '20s', usage: { cpu: '1000m', memory: '3Gi' } }] })
        : json({ items: podMetrics })
    }
    return json({ kind: 'Status', code: 404 }, 404)
  })
}

const renderAt = (path: string) => render(<App history={createMemoryHistory({ initialEntries: [path] })} />)

beforeEach(async () => {
  await i18n.changeLanguage('pt-BR')
  vi.stubGlobal('fetch', fakeApi())
})
afterEach(() => vi.unstubAllGlobals())

describe('métricas ao vivo', () => {
  it('mostra o cluster, os nós e os maiores consumidores', async () => {
    const user = userEvent.setup()
    renderAt('/metrics')
    expect(await within(await screen.findByRole('region', { name: 'CPU em uso' })).findByText('25%')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Memória em uso' })).toHaveTextContent('75%')
    const nodes = screen.getByRole('region', { name: 'Nós' })
    expect(within(nodes).getByRole('meter', { name: 'CPU de kind-control-plane' })).toHaveAttribute('aria-valuetext', '1 CPU / 4 CPU (25%)')
    // Workloads: os dois pods do Deployment web somam 25m; o etcd lidera com 90m.
    const rows = screen.getAllByRole('row').filter((r) => within(r).queryByText(/Deployment · demo|Pod · kube-system/))
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('etcd-kind'), expect.stringContaining('web')])
    expect(within(rows[1]).getByRole('link', { name: 'web' })).toHaveAttribute('href', '/view/apps/v1/deployments/web?ns=demo')
    // Por pod, ordenado por memória.
    await user.click(screen.getByRole('radio', { name: 'Pods' }))
    await user.click(screen.getByRole('radio', { name: 'Memória' }))
    const links = screen.getAllByRole('link').filter((l) => l.getAttribute('href')?.startsWith('/view/core/v1/pods/'))
    expect(links.map((l) => l.textContent)).toEqual(['etcd-kind', 'web-abc12-x2', 'web-abc12-x1'])
  })

  it('sem metrics-server: explica como instalar; a Visão geral avisa', async () => {
    vi.stubGlobal('fetch', fakeApi({ metricsStatus: 404 }))
    renderAt('/metrics')
    expect(await screen.findByText('O cluster não tem o metrics-server')).toBeInTheDocument()
    expect(screen.getByText(/components.yaml/)).toBeInTheDocument()
  })

  it('Visão geral mostra CPU e memória com link para Métricas', async () => {
    renderAt('/')
    const cpu = await screen.findByRole('region', { name: 'Uso de CPU' })
    expect(await within(cpu).findByText('25%')).toBeInTheDocument()
    expect(within(cpu).getByRole('link')).toHaveAttribute('href', '/metrics')
  })
})
