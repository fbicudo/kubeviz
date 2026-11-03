import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import i18n from '@/i18n'
import { charts } from '@/test/setup'

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

let historyRequests: string[]
let historyState = 'ok'
let historyCode = 200
let historyExtra: Record<string, unknown> = {}

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
    if (url === '/api/v1/metrics/status') return json({ state: historyState, interval: '30s', error: 'credencial sem leitura', source: 'collector', ...historyExtra })
    if (url.startsWith('/api/v1/metrics/history?')) {
      historyRequests.push(url)
      if (historyCode !== 200) return json({ error: 'sem permissão para ver este histórico' }, historyCode)
      const now = Math.floor(Date.now() / 1000)
      return json({ step: 30, points: [[now - 600, 100, 1e9, 300, 5e8, 0, 0, 4000, 4e9], [now - 570, 300, 2e9, 300, 5e8, 0, 0, 4000, 4e9], [now - 60, 200, 1.5e9, 300, 5e8, 0, 0, 4000, 4e9]] })
    }
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
  historyRequests = []
  historyState = 'ok'
  historyCode = 200
  historyExtra = {}
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

describe('histórico (coletor embutido)', () => {
  it('mostra CPU e memória do cluster, com lacunas, e troca período e escopo', async () => {
    const user = userEvent.setup()
    renderAt('/metrics')
    const panel = await screen.findByRole('region', { name: 'Histórico' })
    const cpu = await within(panel).findByRole('figure', { name: 'Uso de CPU ao longo do tempo' })
    expect(cpu).toHaveTextContent('Média 200m, máximo 300m, último 200m.')
    expect(historyRequests[0]).toBe('/api/v1/metrics/history?range=1h&kind=cluster')
    // Gráfico de CPU: uso, requests e capacidade; a lacuna de ~8 min vira null.
    // O gráfico é criado no quadro seguinte (cores do tema já aplicadas).
    const cpuChart = await vi.waitFor(() => {
      const c = charts.find((c) => c.series.some((s) => s.label === 'Capacidade'))
      if (!c) throw new Error('gráfico ainda não criado')
      return c
    })
    expect(cpuChart.series.slice(1).map((s) => s.label)).toEqual(['Uso', 'Requests', 'Capacidade'])
    expect(cpuChart.data[1]).toEqual([100, 300, null, 200])

    await user.click(within(panel).getByRole('radio', { name: '7d' }))
    await vi.waitFor(() => expect(historyRequests.at(-1)).toBe('/api/v1/metrics/history?range=7d&kind=cluster'))

    // "Ver histórico" na linha do workload troca o escopo.
    await user.click(screen.getByRole('button', { name: 'Ver o histórico de web' }))
    await vi.waitFor(() => expect(historyRequests.at(-1)).toBe('/api/v1/metrics/history?range=7d&kind=workload&namespace=demo&name=web&ownerKind=Deployment'))
    expect(within(panel).getByRole('combobox', { name: 'Escopo do histórico' })).toHaveTextContent('web')
  })

  it('sem permissão para o escopo, ou coletor sem leitura: explica', async () => {
    historyCode = 403
    renderAt('/metrics')
    expect(await screen.findByText('Você não tem permissão para ver o histórico deste escopo.')).toBeInTheDocument()
  })

  it('coletor sem permissão no cluster', async () => {
    historyState = 'forbidden'
    renderAt('/metrics')
    expect(await screen.findByText(/o KubeViz não tem permissão para ler nós, pods ou métricas/)).toBeInTheDocument()
    expect(historyRequests).toEqual([])
  })

  it('mostra a fonte: coletor, ou Prometheus quando há um completo', async () => {
    historyExtra = { prometheus: { state: 'incomplete', target: 'monitoring/prometheus', missing: ['kube-state-metrics'] } }
    const { unmount } = renderAt('/metrics')
    expect(await screen.findByText('Fonte: coletor embutido')).toBeInTheDocument()
    expect(screen.getByText('Prometheus em monitoring/prometheus não usado: faltam kube-state-metrics.')).toBeInTheDocument()
    unmount()

    historyExtra = { source: 'prometheus', prometheus: { state: 'ok', target: 'monitoring/prometheus-server' } }
    renderAt('/metrics')
    expect(await screen.findByText('Fonte: Prometheus (monitoring/prometheus-server)')).toBeInTheDocument()
    expect(screen.queryByText(/não usado/)).not.toBeInTheDocument()
  })
})
