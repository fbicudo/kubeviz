import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import i18n from '@/i18n'

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const discoveryCore = {
  kind: 'APIGroupDiscoveryList',
  items: [{ metadata: {}, versions: [{ version: 'v1', resources: [
    { resource: 'namespaces', scope: 'Cluster', responseKind: { kind: 'Namespace' } },
    { resource: 'configmaps', scope: 'Namespaced', responseKind: { kind: 'ConfigMap' } },
  ] }] }],
}
const discoveryGroups = {
  kind: 'APIGroupDiscoveryList',
  items: [{ metadata: { name: 'apps' }, versions: [{ version: 'v1', resources: [
    { resource: 'deployments', scope: 'Namespaced', responseKind: { kind: 'Deployment' } },
  ] }] }],
}
const meta = (name: string, namespace?: string) => ({ name, namespace, uid: name, creationTimestamp: '2026-11-02T00:00:00Z' })

let created: Set<string>
let patches: string[]

function fakeApi() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/v1/auth/session') return json({ mode: 'local', loginMethods: ['link'], authenticated: true })
    if (url === '/api/v1/cluster') return json({ mode: 'local', reachable: true, server: 'x', version: 'v1.37.0' })
    if (url === '/api/v1/contexts') return json({ mode: 'local', contexts: [] })
    if (url === '/api/k8s/api') return json(discoveryCore)
    if (url === '/api/k8s/apis') return json(discoveryGroups)
    if (url === '/api/k8s/api/v1/namespaces') return json({ kind: 'List', metadata: {}, items: [] })
    const path = url.replace(/^\/api\/k8s/, '').split('?')[0]
    if (method === 'GET') {
      if (path === '/apis/apps/v1/namespaces/demo/deployments/web') return json({ metadata: meta('web', 'demo'), spec: { replicas: 2 } })
      return json({ kind: 'Status', code: 404, message: 'not found' }, 404)
    }
    if (method === 'PATCH') {
      const dry = url.includes('dryRun=All')
      if (!dry) patches.push(path)
      if (path.startsWith('/api/v1/namespaces/teste/') && !created.has('teste')) {
        return json({ kind: 'Status', code: 404, reason: 'NotFound', message: 'namespaces "teste" not found' }, 404)
      }
      if (path === '/api/v1/namespaces/teste' && !dry) created.add('teste')
      if (path.endsWith('/deployments/web')) return json({ metadata: meta('web', 'demo'), spec: { replicas: 3 } })
      return json({ metadata: meta(path.split('/').pop()!) })
    }
    return json({}, 404)
  })
}

beforeEach(async () => {
  created = new Set()
  patches = []
  await i18n.changeLanguage('pt-BR')
  vi.stubGlobal('fetch', fakeApi())
})
afterEach(() => vi.unstubAllGlobals())

const YAML = `apiVersion: v1
kind: Namespace
metadata: {name: teste}
---
apiVersion: v1
kind: ConfigMap
metadata: {name: config, namespace: teste}
data: {chave: valor}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: web, namespace: demo}
spec: {replicas: 3}
`

async function loadYaml(text: string) {
  render(<App history={createMemoryHistory({ initialEntries: ['/apply'] })} />)
  const input = await screen.findByLabelText('Importar arquivo')
  await userEvent.upload(input, new File([text], 'app.yaml', { type: 'application/yaml' }))
  await screen.findByLabelText('YAML a aplicar')
}

describe('aplicar YAML', () => {
  it('valida o lote (novo, aguarda namespace, alterado) e aplica na ordem', async () => {
    await loadYaml(YAML)
    const validar = screen.getByRole('button', { name: 'Validar' })
    await vi.waitFor(() => expect(validar).toBeEnabled())
    await userEvent.click(validar)

    expect(
      await screen.findByText('3 objeto(s): 1 novo(s), 1 alterado(s), 0 sem mudanças. 1 aguarda o namespace deste lote.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Novo')).toBeInTheDocument()
    expect(screen.getByText('Aguarda namespace')).toBeInTheDocument()
    expect(screen.getByText('Alterado')).toBeInTheDocument()
    expect(screen.getByText('replicas: 3')).toBeInTheDocument()
    expect(patches).toEqual([]) // validação não altera nada

    await userEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    expect(await screen.findByText('3 objetos aplicados.')).toBeInTheDocument()
    expect(patches).toEqual([
      '/api/v1/namespaces/teste',
      '/api/v1/namespaces/teste/configmaps/config',
      '/apis/apps/v1/namespaces/demo/deployments/web',
    ])
    expect(screen.getByRole('link', { name: 'config' })).toHaveAttribute('href', '/view/core/v1/configmaps/config?ns=teste')

    // Validar de novo não mostra o resultado anterior durante a validação.
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }))
    expect(screen.queryByText('3 objetos aplicados.')).not.toBeInTheDocument()
    expect(screen.queryByText(/0 novo\(s\), 0 alterado\(s\), 0 sem mudanças/)).not.toBeInTheDocument()
  })

  it('tipo desconhecido impede aplicar', async () => {
    await loadYaml('apiVersion: example.com/v1\nkind: Widget\nmetadata: {name: w}\n')
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Validar' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }))
    expect(await screen.findByText(/o cluster não conhece o tipo example.com\/v1 Widget/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled()
  })
})
