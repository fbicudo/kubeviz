import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import i18n from '@/i18n'

const created = new Date(Date.now() - 3 * 3600_000).toISOString()
const list = (items: unknown[]) => ({ kind: 'List', metadata: { resourceVersion: '1' }, items })
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const sel = (s: string) => `?fieldSelector=${encodeURIComponent(s)}`

const deployment = {
  metadata: { name: 'web', namespace: 'demo', uid: 'uid-web', creationTimestamp: created, labels: { app: 'web' } },
  spec: { template: { spec: { containers: [{ name: 'nginx', image: 'nginx:1.29', ports: [{ containerPort: 80 }] }] } } },
  status: {
    conditions: [{ type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable', lastTransitionTime: created }],
  },
}
const pod = {
  metadata: {
    name: 'web-1',
    namespace: 'demo',
    uid: 'uid-web-1',
    creationTimestamp: created,
    ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-abc', uid: 'rs', controller: true }],
  },
  spec: { nodeName: 'kind-node', containers: [{ name: 'app', image: 'busybox' }] },
  status: {
    phase: 'Running',
    podIP: '10.0.0.9',
    containerStatuses: [{ name: 'app', ready: false, restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } } }],
  },
}
const secret = {
  metadata: { name: 'db', namespace: 'demo', uid: 'uid-db', creationTimestamp: created },
  type: 'Opaque',
  data: { senha: btoa('valor-secreto') },
}
const event = {
  metadata: { name: 'ev', namespace: 'demo', uid: 'ev1', creationTimestamp: created },
  type: 'Warning',
  reason: 'BackOff',
  message: 'Back-off restarting failed container',
  count: 7,
  lastTimestamp: created,
}

function fakeApi() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('watch=1')) return json({}, 404)
    const routes: Record<string, unknown> = {
      '/api/v1/auth/session': { mode: 'local', loginMethods: ['link'], authenticated: true },
      '/api/v1/cluster': { mode: 'local', reachable: true, server: 'x', version: 'v1.37.0' },
      '/api/v1/contexts': { mode: 'local', contexts: [] },
      [`/api/k8s/apis/apps/v1/namespaces/demo/deployments${sel('metadata.name=web')}`]: list([deployment]),
      [`/api/k8s/api/v1/namespaces/demo/pods${sel('metadata.name=web-1')}`]: list([pod]),
      [`/api/k8s/api/v1/namespaces/demo/secrets${sel('metadata.name=db')}`]: list([secret]),
      [`/api/k8s/api/v1/namespaces/demo/pods${sel('metadata.name=sumiu')}`]: list([]),
      [`/api/k8s/api/v1/namespaces/demo/events${sel('involvedObject.uid=uid-web-1')}`]: list([event]),
    }
    return url in routes ? json(routes[url]) : json({ kind: 'Status', code: 404, message: 'not found' }, 404)
  })
}

const renderAt = (path: string) => render(<App history={createMemoryHistory({ initialEntries: [path] })} />)

beforeEach(async () => {
  await i18n.changeLanguage('pt-BR')
  vi.stubGlobal('fetch', fakeApi())
})
afterEach(() => vi.unstubAllGlobals())

describe('detalhe de recurso', () => {
  it('mostra metadados, condições e containers do template', async () => {
    renderAt('/view/apps/v1/deployments/web?ns=demo')
    expect(await screen.findByRole('heading', { name: 'web' })).toBeInTheDocument()
    expect(await screen.findByText('app=web')).toBeInTheDocument()
    expect(screen.getByText('MinimumReplicasAvailable')).toBeInTheDocument()
    expect(screen.getByText('nginx:1.29')).toBeInTheDocument()
    expect(screen.getByText('80/TCP')).toBeInTheDocument()
    // Status resumido pela condição Available.
    expect(screen.getAllByText('Available')[0]).toHaveClass('text-ok')
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Deployments' })).toHaveAttribute('href', '/deployments?ns=demo')
  })

  it('pod: status, reinícios, nó e dono com links', async () => {
    renderAt('/view/core/v1/pods/web-1?ns=demo')
    expect(await screen.findByRole('heading', { name: 'web-1' })).toBeInTheDocument()
    expect((await screen.findAllByText('CrashLoopBackOff')).length).toBeGreaterThan(0)
    expect(screen.getByText('4 reinícios')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'web-abc' })).toHaveAttribute('href', '/view/apps/v1/replicasets/web-abc?ns=demo')
    expect(screen.getByRole('link', { name: 'kind-node' })).toHaveAttribute('href', '/view/core/v1/nodes/kind-node')
  })

  it('aba de eventos lista os eventos do objeto', async () => {
    renderAt('/view/core/v1/pods/web-1?ns=demo&tab=events')
    expect(await screen.findByText('Back-off restarting failed container')).toBeInTheDocument()
    expect(screen.getByText('BackOff')).toHaveClass('text-warn')
    expect(screen.getByText(/7 vezes/)).toBeInTheDocument()
  })

  it('Secret: valores ocultos até pedir, e decodificados ao revelar', async () => {
    renderAt('/view/core/v1/secrets/db?ns=demo&tab=yaml')
    const yaml = await screen.findByText(/kind: Secret/)
    expect(yaml.textContent).toContain('senha: ••••••')
    expect(yaml.textContent).not.toContain(btoa('valor-secreto'))
    expect(screen.queryByText('valor-secreto')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Mostrar valores' }))
    expect(await screen.findByText('valor-secreto')).toBeInTheDocument()
  })

  it('YAML omite managedFields e completa apiVersion e kind', async () => {
    renderAt('/view/apps/v1/deployments/web?ns=demo&tab=yaml')
    const yaml = await screen.findByText(/kind: Deployment/)
    expect(yaml.textContent).toContain('apiVersion: apps/v1')
    expect(yaml.textContent).not.toContain('managedFields')
  })

  it('objeto inexistente', async () => {
    renderAt('/view/core/v1/pods/sumiu?ns=demo')
    expect(await screen.findByText('Objeto não encontrado')).toBeInTheDocument()
  })

  it('o nome na lista abre o detalhe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/k8s/apis/apps/v1/namespaces/demo/deployments') {
          return json({
            kind: 'Table',
            metadata: {},
            columnDefinitions: [{ name: 'Name', type: 'string', priority: 0 }],
            rows: [{ cells: ['web'], object: { metadata: deployment.metadata } }],
          })
        }
        return fakeApi()(input)
      }),
    )
    renderAt('/deployments?ns=demo')
    const table = await screen.findByRole('table')
    await userEvent.click(await within(table).findByRole('link', { name: 'web' }))
    expect(await screen.findByText('MinimumReplicasAvailable')).toBeInTheDocument()
  })
})
