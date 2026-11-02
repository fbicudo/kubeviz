import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import i18n from '@/i18n'
import { collectionPath, kinds } from '@/lib/k8s/catalog'

const created = new Date(Date.now() - 2 * 3600_000).toISOString()
const meta = (name: string, namespace?: string) => ({
  metadata: { name, namespace, uid: `${namespace}/${name}`, creationTimestamp: created },
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const table = (columns: [string, number][], rows: { obj: ReturnType<typeof meta>; cells: unknown[] }[]) => ({
  kind: 'Table',
  metadata: {},
  columnDefinitions: columns.map(([name, priority]) => ({ name, type: 'string', priority })),
  rows: rows.map((r) => ({ cells: r.cells, object: r.obj })),
})

const deployments = table(
  [['Name', 0], ['Ready', 0], ['Up-to-date', 0], ['Age', 0], ['Images', 1]],
  [
    { obj: meta('web', 'demo'), cells: ['web', '2/2', 2, '2h', 'nginx:1.29'] },
    { obj: meta('coredns', 'kube-system'), cells: ['coredns', '2/2', 2, '2h', 'coredns:1.12'] },
  ],
)
const nodes = table([['Name', 0], ['Status', 0], ['Roles', 0], ['Age', 0]], [
  { obj: meta('kind-control-plane'), cells: ['kind-control-plane', 'Ready', 'control-plane', '2h'] },
])

let calls: { url: string; accept: string }[] = []

function fakeApi({ restricted = false } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, accept: new Headers(init?.headers).get('Accept') ?? '' })
    if (url === '/api/v1/auth/session') return json({ mode: 'local', authenticated: true, user: { username: 'admin' } })
    if (url === '/api/v1/cluster') return json({ mode: 'local', context: 'kind', server: 'x', reachable: true, version: 'v1.37.0' })
    if (url === '/api/v1/contexts') return json({ mode: 'local', contexts: [] })
    if (url === '/api/k8s/api/v1/namespaces') {
      return json({ kind: 'List', metadata: {}, items: [meta('demo'), meta('kube-system')].map((m) => ({ ...m, status: {} })) })
    }
    if (url === '/api/k8s/apis/apps/v1/deployments') return json(deployments)
    if (url === '/api/k8s/apis/apps/v1/namespaces/demo/deployments') {
      return json({ ...deployments, rows: deployments.rows.slice(0, 1) })
    }
    if (url === '/api/k8s/apis/apps/v1/replicasets') {
      return json(table([['Name', 0], ['Desired', 0]], [{ obj: meta('web-abc', 'demo'), cells: ['web-abc', 2] }]))
    }
    if (url === '/api/k8s/api/v1/nodes') return json(nodes)
    if (url.startsWith('/api/k8s/apis/gateway.networking.k8s.io/')) return json({ kind: 'Status', message: 'the server could not find the requested resource', code: 404 }, 404)
    if (url === '/api/k8s/api/v1/secrets' && restricted) {
      return json({ kind: 'Status', message: 'secrets is forbidden: User "dev" cannot list resource "secrets"', code: 403 }, 403)
    }
    return json({ kind: 'Status', message: 'not found', code: 404 }, 404)
  })
}

function renderAt(path: string) {
  return render(<App history={createMemoryHistory({ initialEntries: [path] })} />)
}

beforeEach(async () => {
  calls = []
  await i18n.changeLanguage('pt-BR')
  vi.stubGlobal('fetch', fakeApi())
})
afterEach(() => vi.unstubAllGlobals())

describe('catálogo', () => {
  it('todo tipo tem nome traduzido nos dois idiomas', () => {
    for (const lng of ['pt-BR', 'en']) {
      for (const id of Object.keys(kinds)) {
        expect(i18n.exists(`kinds.${id}`, { lng }), `kinds.${id} em ${lng}`).toBe(true)
      }
    }
  })
})

describe('collectionPath', () => {
  it('monta caminhos do grupo core, de grupos e com namespace', () => {
    expect(collectionPath(kinds.pvcs, '')).toBe('/api/v1/persistentvolumeclaims')
    expect(collectionPath(kinds.deployments, 'demo')).toBe('/apis/apps/v1/namespaces/demo/deployments')
    // Recursos sem namespace ignoram o namespace escolhido.
    expect(collectionPath(kinds.nodes, 'demo')).toBe('/api/v1/nodes')
  })
})

describe('lista genérica', () => {
  it('usa as colunas definidas pelo cluster e pede o formato Table', async () => {
    renderAt('/deployments')
    const tableEl = await screen.findByRole('table')
    expect(await within(tableEl).findByText('coredns')).toBeInTheDocument()
    for (const h of ['Name', 'Namespace', 'Ready', 'Up-to-date', 'Age']) {
      expect(within(tableEl).getByRole('columnheader', { name: h })).toBeInTheDocument()
    }
    expect(within(tableEl).queryByRole('columnheader', { name: 'Images' })).not.toBeInTheDocument()
    expect(screen.getByText('2 de 2 itens')).toBeInTheDocument()

    const req = calls.find((c) => c.url === '/api/k8s/apis/apps/v1/deployments')
    expect(req?.accept).toContain('as=Table')
  })

  it('"Mais colunas" mostra as colunas do modo wide', async () => {
    renderAt('/deployments')
    await screen.findByText('coredns')
    await userEvent.click(screen.getByRole('button', { name: 'Mais colunas' }))
    expect(screen.getByRole('columnheader', { name: 'Images' })).toBeInTheDocument()
    expect(screen.getByText('nginx:1.29')).toBeInTheDocument()
  })

  it('namespace pela URL consulta só aquele namespace e oculta a coluna', async () => {
    renderAt('/deployments?ns=demo')
    expect(await screen.findByText('web')).toBeInTheDocument()
    expect(screen.queryByText('coredns')).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Namespace' })).not.toBeInTheDocument()
  })

  it('abas trocam o tipo de recurso', async () => {
    renderAt('/deployments')
    await screen.findByText('coredns')
    await userEvent.click(screen.getByRole('tab', { name: 'ReplicaSets' }))
    expect(await screen.findByText('web-abc')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'ReplicaSets' })).toHaveAttribute('aria-selected', 'true')
  })

  it('recurso sem namespace: sem seletor e com status colorido', async () => {
    renderAt('/nodes')
    expect(await screen.findByText('kind-control-plane')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Namespace' })).not.toBeInTheDocument()
    expect(screen.getByText('Ready')).toHaveClass('text-ok')
  })

  it('colunas de data mostram a idade', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/v1/auth/session') return json({ mode: 'local', authenticated: true })
        if (url === '/api/k8s/apis/rbac.authorization.k8s.io/v1/clusterroles') {
          return json({
            kind: 'Table',
            metadata: {},
            columnDefinitions: [
              { name: 'Name', type: 'string', priority: 0 },
              { name: 'Created At', type: 'date', priority: 0 },
            ],
            rows: [{ cells: ['admin', created], object: meta('admin') }],
          })
        }
        return json({}, 404)
      }),
    )
    renderAt('/rbac?k=clusterroles')
    expect(await screen.findByText('2h')).toHaveAttribute('title', created)
  })

  it('extensão ausente aparece como não instalada', async () => {
    renderAt('/ingresses?k=gateways')
    expect(await screen.findByText('Gateways não está instalado neste cluster')).toBeInTheDocument()
  })

  it('sem permissão: mensagem clara com o texto da API', async () => {
    vi.stubGlobal('fetch', fakeApi({ restricted: true }))
    renderAt('/secrets')
    expect(await screen.findByText('Sem permissão para listar Secrets em todos os namespaces')).toBeInTheDocument()
    expect(screen.getByText(/cannot list resource "secrets"/)).toBeInTheDocument()
  })
})
