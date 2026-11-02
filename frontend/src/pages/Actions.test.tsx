import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import i18n from '@/i18n'

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const created = '2026-11-02T00:00:00Z'
const deployment = {
  metadata: { name: 'web', namespace: 'demo', uid: 'dep-uid', creationTimestamp: created, resourceVersion: '1', annotations: { 'deployment.kubernetes.io/revision': '2' } },
  spec: { replicas: 2, template: { spec: { containers: [{ name: 'c', image: 'nginx:2' }] } } },
}
const rs = (rev: number, image: string) => ({
  metadata: {
    name: `web-${rev}`, namespace: 'demo', uid: `rs-${rev}`, creationTimestamp: created,
    annotations: { 'deployment.kubernetes.io/revision': String(rev) },
    ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', uid: 'dep-uid' }],
  },
  spec: { template: { metadata: { labels: { app: 'web', 'pod-template-hash': `h${rev}` } }, spec: { containers: [{ name: 'c', image }] } } },
})
const node = { metadata: { name: 'kind-node', uid: 'n1', creationTimestamp: created, resourceVersion: '1' }, spec: {}, status: {} }

let writes: { method: string; url: string; body?: unknown; ct?: string }[]
let allowed: (attrs: { verb: string; subresource?: string }) => boolean

function fakeApi() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.includes('watch=1')) return json({}, 404)
    if (url === '/api/v1/auth/session') return json({ mode: 'local', loginMethods: ['link'], authenticated: true })
    if (url === '/api/v1/cluster') return json({ mode: 'local', reachable: true, server: 'x', version: 'v1.37.0' })
    if (url === '/api/v1/contexts') return json({ mode: 'local', contexts: [] })
    if (url.endsWith('/selfsubjectaccessreviews')) {
      const attrs = JSON.parse(String(init?.body)).spec.resourceAttributes
      return json({ status: { allowed: allowed(attrs) } })
    }
    if (method !== 'GET') {
      writes.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, ct: new Headers(init?.headers).get('Content-Type') ?? undefined })
      return json({})
    }
    if (url.startsWith('/api/k8s/apis/apps/v1/namespaces/demo/deployments?fieldSelector')) return json({ kind: 'List', metadata: { resourceVersion: '1' }, items: [deployment] })
    if (url === '/api/k8s/apis/apps/v1/namespaces/demo/replicasets') return json({ kind: 'List', metadata: {}, items: [rs(1, 'nginx:1'), rs(2, 'nginx:2')] })
    if (url.startsWith('/api/k8s/api/v1/nodes?fieldSelector')) return json({ kind: 'List', metadata: { resourceVersion: '1' }, items: [node] })
    return json({ kind: 'Status', code: 404, message: 'not found' }, 404)
  })
}

beforeEach(async () => {
  writes = []
  allowed = () => true
  await i18n.changeLanguage('pt-BR')
  vi.stubGlobal('fetch', fakeApi())
})
afterEach(() => vi.unstubAllGlobals())

const renderAt = (path: string) => render(<App history={createMemoryHistory({ initialEntries: [path] })} />)
const toolbar = () => screen.findByRole('toolbar', { name: 'Ações' })

describe('ações', () => {
  it('mostra só as ações permitidas pelo RBAC', async () => {
    allowed = (a) => a.verb === 'patch' && a.subresource === 'scale'
    renderAt('/view/apps/v1/deployments/web?ns=demo')
    const bar = await toolbar()
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Escalar'])
  })

  it('sem permissão nenhuma, não há barra de ações', async () => {
    allowed = () => false
    renderAt('/view/apps/v1/deployments/web?ns=demo')
    await screen.findByText('nginx:2')
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('toolbar', { name: 'Ações' })).not.toBeInTheDocument()
  })

  it('escala pelo subrecurso scale', async () => {
    renderAt('/view/apps/v1/deployments/web?ns=demo')
    await userEvent.click(within(await toolbar()).getByRole('button', { name: 'Escalar' }))
    const input = screen.getByLabelText('Réplicas')
    await userEvent.clear(input)
    await userEvent.type(input, '5')
    await userEvent.click(screen.getByRole('button', { name: 'Escalar para 5 réplicas' }))
    expect(await screen.findByText('Escalado para 5 réplicas.')).toBeInTheDocument()
    expect(writes[0]).toMatchObject({
      method: 'PATCH',
      url: '/api/k8s/apis/apps/v1/namespaces/demo/deployments/web/scale?fieldManager=kubeviz',
      body: { spec: { replicas: 5 } },
      ct: 'application/merge-patch+json',
    })
  })

  it('excluir exige digitar o nome e volta para a lista', async () => {
    renderAt('/view/apps/v1/deployments/web?ns=demo')
    await userEvent.click(within(await toolbar()).getByRole('button', { name: 'Excluir' }))
    const dialog = screen.getByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Excluir' })
    expect(confirm).toBeDisabled()
    await userEvent.type(within(dialog).getByRole('textbox'), 'we')
    expect(confirm).toBeDisabled()
    await userEvent.type(within(dialog).getByRole('textbox'), 'b')
    await userEvent.click(confirm)
    await vi.waitFor(() => expect(writes[0]?.method).toBe('DELETE'))
    expect(writes[0].url).toBe('/api/k8s/apis/apps/v1/namespaces/demo/deployments/web')
    expect(writes[0].ct).toBe('application/json')
    expect(await screen.findByRole('heading', { name: 'Deployments' })).toBeInTheDocument()
  })

  it('volta para uma revisão anterior com o template do ReplicaSet', async () => {
    renderAt('/view/apps/v1/deployments/web?ns=demo')
    await userEvent.click(within(await toolbar()).getByRole('button', { name: 'Voltar revisão' }))
    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByText('nginx:1')).toBeInTheDocument()
    expect(within(dialog).getAllByRole('radio')[0]).toBeDisabled() // revisão atual
    await userEvent.click(within(dialog).getAllByRole('radio')[1])
    await userEvent.click(within(dialog).getByRole('button', { name: 'Voltar para a revisão 1' }))
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].ct).toBe('application/json-patch+json')
    const [op] = writes[0].body as { op: string; path: string; value: { metadata: { labels: Record<string, string> }; spec: unknown } }[]
    expect(op).toMatchObject({ op: 'replace', path: '/spec/template' })
    expect(op.value.metadata.labels).toEqual({ app: 'web' })
  })

  it('nó: bloquear agendamento (cordon)', async () => {
    renderAt('/view/core/v1/nodes/kind-node')
    await userEvent.click(within(await toolbar()).getByRole('button', { name: 'Bloquear agendamento' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Bloquear agendamento' }))
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ url: '/api/k8s/api/v1/nodes/kind-node?fieldManager=kubeviz', body: { spec: { unschedulable: true } } })
  })
})
