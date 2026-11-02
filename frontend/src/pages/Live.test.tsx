import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import i18n from '@/i18n'

// Stream de watch controlado pelo teste: cada push envia um evento ao navegador.
function controllableStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) })
  const enc = new TextEncoder()
  return { body, push: (ev: unknown) => ctrl.enqueue(enc.encode(JSON.stringify(ev) + '\n')) }
}

const created = new Date(Date.now() - 60_000).toISOString()
const pod = (name: string, rv: string) => ({
  metadata: { name, namespace: 'demo', uid: `uid-${name}`, creationTimestamp: created, resourceVersion: rv },
  spec: { containers: [{ name: 'app' }] },
  status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }] },
})
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })

let watchUrls: string[] = []

function fakeApi(opts: { watchStatus?: number } = {}) {
  const stream = controllableStream()
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/v1/auth/session') return json({ mode: 'local', authenticated: true })
    if (url === '/api/v1/cluster') return json({ mode: 'local', reachable: true, server: 'x', version: 'v1.37.0' })
    if (url === '/api/v1/contexts') return json({ mode: 'local', contexts: [] })
    if (url === '/api/k8s/api/v1/namespaces') return json({ kind: 'List', metadata: {}, items: [] })
    if (url.startsWith('/api/k8s/api/v1/pods?watch=1')) {
      watchUrls.push(url)
      if (opts.watchStatus) return json({ kind: 'Status', code: opts.watchStatus, message: 'forbidden' }, opts.watchStatus)
      return new Response(stream.body, { status: 200 })
    }
    if (url === '/api/k8s/api/v1/pods') {
      return json({ kind: 'PodList', metadata: { resourceVersion: '100' }, items: [pod('web-1', '90')] })
    }
    return json({}, 404)
  })
  return { fetchMock, push: stream.push }
}

beforeEach(async () => {
  watchUrls = []
  await i18n.changeLanguage('pt-BR')
})
afterEach(() => vi.unstubAllGlobals())

describe('pods em tempo real', () => {
  it('aplica eventos do watch sem recarregar a lista', async () => {
    const api = fakeApi()
    vi.stubGlobal('fetch', api.fetchMock)
    render(<App history={createMemoryHistory({ initialEntries: ['/pods'] })} />)

    expect(await screen.findByText('web-1')).toBeInTheDocument()
    expect(await screen.findByText('Ao vivo')).toBeInTheDocument()
    expect(watchUrls[0]).toContain('resourceVersion=100')

    api.push({ type: 'ADDED', object: pod('web-2', '101') })
    expect(await screen.findByText('web-2')).toBeInTheDocument()

    api.push({ type: 'DELETED', object: pod('web-1', '102') })
    await vi.waitFor(() => expect(screen.queryByText('web-1')).not.toBeInTheDocument())
    expect(screen.getByText('1 de 1 pod')).toBeInTheDocument()
  })

  it('sem permissão de watch, volta à consulta periódica', async () => {
    vi.stubGlobal('fetch', fakeApi({ watchStatus: 403 }).fetchMock)
    render(<App history={createMemoryHistory({ initialEntries: ['/pods'] })} />)
    expect(await screen.findByText('web-1')).toBeInTheDocument()
    expect(await screen.findByText('A cada 10 s')).toBeInTheDocument()
  })
})
