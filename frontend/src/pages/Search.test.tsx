import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import i18n from '@/i18n'

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const meta = (name: string, namespace?: string) => ({ name, namespace, uid: `${namespace}/${name}`, creationTimestamp: ago(120) })

const discoveryCore = {
  kind: 'APIGroupDiscoveryList',
  items: [{ metadata: {}, versions: [{ version: 'v1', resources: [
    { resource: 'pods', scope: 'Namespaced', responseKind: { kind: 'Pod' } },
  ] }] }],
}
const discoveryGroups = {
  kind: 'APIGroupDiscoveryList',
  items: [
    { metadata: { name: 'apps' }, versions: [{ version: 'v1', resources: [
      { resource: 'deployments', scope: 'Namespaced', responseKind: { kind: 'Deployment' } },
    ] }] },
    { metadata: { name: 'admissionregistration.k8s.io' }, versions: [{ version: 'v1', resources: [
      { resource: 'mutatingwebhookconfigurations', scope: 'Cluster', responseKind: { kind: 'MutatingWebhookConfiguration' } },
    ] }] },
    { metadata: { name: 'demo.kubeviz.dev' }, versions: [{ version: 'v1', resources: [
      { resource: 'widgets', scope: 'Namespaced', responseKind: { kind: 'Widget' } },
    ] }] },
  ],
}
const widgetCrd = {
  metadata: meta('widgets.demo.kubeviz.dev'),
  spec: {
    group: 'demo.kubeviz.dev', scope: 'Namespaced', names: { kind: 'Widget', plural: 'widgets' },
    versions: [{ name: 'v1', served: true, storage: true }],
  },
}
const widgets = {
  kind: 'Table', metadata: {},
  columnDefinitions: [['Name', 0], ['Cor', 0], ['Tamanho', 0]].map(([name, priority]) => ({ name, type: 'string', priority })),
  rows: [{ cells: ['alfa', 'azul', 3], object: { metadata: meta('alfa', 'demo') } }],
}
const event = (name: string, type: string, reason: string, message: string, involved: string, min: number) => ({
  metadata: meta(name, 'demo'), type, reason, message, count: 1, lastTimestamp: ago(min),
  involvedObject: { apiVersion: 'v1', kind: 'Pod', name: involved, namespace: 'demo' },
})
const events = [
  event('e1', 'Normal', 'Pulled', 'Container image "nginx" already present', 'web-1', 30),
  event('e2', 'Warning', 'BackOff', 'Back-off restarting failed container', 'quebrado-1', 1),
  event('e3', 'Warning', 'Failed', 'Failed to pull image "nao-existe"', 'imagem-1', 5),
]

function fakeApi() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/v1/auth/session') return json({ mode: 'local', loginMethods: ['link'], authenticated: true })
    if (url === '/api/v1/cluster') return json({ mode: 'local', reachable: true, server: 'x', version: 'v1.37.0' })
    if (url === '/api/v1/contexts') return json({ mode: 'local', contexts: [] })
    if (url === '/api/k8s/api') return json(discoveryCore)
    if (url === '/api/k8s/apis') return json(discoveryGroups)
    if (url === '/api/k8s/api/v1/namespaces') return json({ metadata: {}, items: [{ metadata: meta('demo') }] })
    if (url === '/api/k8s/api/v1/pods') return json({ metadata: {}, items: [{ metadata: meta('web-1', 'demo') }, { metadata: meta('quebrado-1', 'demo') }] })
    if (url === '/api/k8s/apis/apps/v1/deployments') return json({ metadata: {}, items: [{ metadata: meta('web', 'demo') }] })
    if (url === '/api/k8s/api/v1/secrets') return json({ kind: 'Status', code: 403, message: 'forbidden' }, 403)
    if (url === '/api/k8s/api/v1/events') return json({ kind: 'EventList', metadata: {}, items: events })
    if (url === '/api/k8s/apis/apiextensions.k8s.io/v1/customresourcedefinitions') return json({ metadata: {}, items: [widgetCrd] })
    if (url === '/api/k8s/apis/demo.kubeviz.dev/v1/widgets') return json(widgets)
    if (url.includes('/apis/') && url.endsWith('s') && !url.includes('?')) return json({ metadata: {}, items: [] })
    return json({ kind: 'Status', code: 404, message: 'not found' }, 404)
  })
}

const renderAt = (path: string) => render(<App history={createMemoryHistory({ initialEntries: [path] })} />)

beforeEach(async () => {
  await i18n.changeLanguage('pt-BR')
  vi.stubGlobal('fetch', fakeApi())
})
afterEach(() => vi.unstubAllGlobals())

describe('busca global (Ctrl+K)', () => {
  it('abre pelo atalho e encontra objetos pelo nome', async () => {
    const user = userEvent.setup()
    renderAt('/nodes')
    await screen.findByRole('heading', { name: 'Nós' })
    await user.keyboard('{Control>}k{/Control}')
    const dialog = await screen.findByRole('dialog', { name: 'Busca global' })
    await user.type(within(dialog).getByRole('combobox'), 'web')
    const hit = await within(dialog).findByRole('option', { name: /^webDeployments · demo/ })
    expect(within(dialog).getByRole('option', { name: /^web-1Pods · demo/ })).toBeInTheDocument()
    // A seleção acompanha o primeiro resultado, que chega depois dos tipos.
    expect(hit).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { name: 'web' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('encontra páginas e tipos de recurso, inclusive CRDs', async () => {
    const user = userEvent.setup()
    renderAt('/nodes')
    await user.click(await screen.findByRole('button', { name: /Buscar recursos/ }))
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByRole('combobox')
    await user.type(input, 'eventos')
    expect(await within(dialog).findByRole('option', { name: 'Eventos' })).toBeInTheDocument()
    await user.clear(input)
    await user.type(input, 'widg')
    await user.click(await within(dialog).findByRole('option', { name: /^Widgetdemo\.kubeviz\.dev\/v1/ }))
    expect(await screen.findByRole('heading', { name: 'Widget' })).toBeInTheDocument()
    expect(await screen.findByRole('cell', { name: 'azul' })).toBeInTheDocument()
  })
})

describe('eventos', () => {
  it('lista do mais recente ao mais antigo e filtra avisos e texto', async () => {
    const user = userEvent.setup()
    renderAt('/events')
    const list = await screen.findByRole('list', { name: 'Eventos' })
    await within(list).findByText(/Back-off restarting/)
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => within(r).getAllByRole('link')[0]?.textContent)).toEqual(['quebrado-1', 'imagem-1', 'web-1'])
    expect(within(rows[0]).getByRole('link', { name: 'quebrado-1' })).toHaveAttribute('href', '/view/core/v1/pods/quebrado-1?ns=demo')

    await user.click(screen.getByRole('radio', { name: 'Avisos (2)' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    await user.type(screen.getByRole('textbox', { name: /Filtrar/ }), 'pull')
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).getByText(/nao-existe/)).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Todos (3)' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  })
})

describe('recursos personalizados', () => {
  it('lista os CRDs com link para os objetos de cada um', async () => {
    const user = userEvent.setup()
    renderAt('/crds')
    const link = await screen.findByRole('link', { name: 'Widget' })
    expect(link).toHaveAttribute('href', '/list/demo.kubeviz.dev/v1/widgets')
    await user.click(link)
    expect(await screen.findByRole('cell', { name: 'alfa' })).toBeInTheDocument()
  })

  it('tipo desconhecido mostra aviso', async () => {
    renderAt('/list/nao.existe/v1/coisas')
    expect(await screen.findByText(/O cluster não conhece o tipo/)).toBeInTheDocument()
  })
})
