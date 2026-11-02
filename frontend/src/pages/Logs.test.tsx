import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import i18n from '@/i18n'

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const pod = {
  metadata: { name: 'relogio-1', namespace: 'demo', uid: 'u1', creationTimestamp: '2026-11-02T00:00:00Z', resourceVersion: '1' },
  spec: { containers: [{ name: 'relogio' }] },
  status: { phase: 'Running', containerStatuses: [{ name: 'relogio', ready: true, restartCount: 3, state: { running: {} } }] },
}

let push!: (text: string) => void
let close!: () => void
let logUrls: string[] = []

function fakeApi({ previousMissing = false } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('watch=1')) return json({}, 404)
    if (url === '/api/v1/auth/session') return json({ mode: 'local', loginMethods: ['link'], authenticated: true })
    if (url === '/api/v1/cluster') return json({ mode: 'local', reachable: true, server: 'x', version: 'v1.37.0' })
    if (url === '/api/v1/contexts') return json({ mode: 'local', contexts: [] })
    if (url.startsWith('/api/k8s/api/v1/namespaces/demo/pods?fieldSelector')) {
      return json({ kind: 'List', metadata: { resourceVersion: '1' }, items: [pod] })
    }
    if (url.includes('/pods/relogio-1/log')) {
      logUrls.push(url)
      if (url.includes('previous=true') && previousMissing) {
        return json({ kind: 'Status', code: 400, message: 'previous terminated container "relogio" in pod "relogio-1" not found' }, 400)
      }
      const enc = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          push = (t) => c.enqueue(enc.encode(t))
          close = () => c.close()
        },
      })
      return new Response(body, { status: 200 })
    }
    return json({}, 404)
  })
}

beforeEach(async () => {
  logUrls = []
  await i18n.changeLanguage('pt-BR')
  vi.stubGlobal('fetch', fakeApi())
})
afterEach(() => vi.unstubAllGlobals())

const open = () => render(<App history={createMemoryHistory({ initialEntries: ['/view/core/v1/pods/relogio-1?ns=demo&tab=logs'] })} />)

describe('logs do pod', () => {
  it('mostra linhas ao vivo sem códigos ANSI e permite buscar', async () => {
    open()
    const log = await screen.findByRole('log')
    await vi.waitFor(() => expect(logUrls).toHaveLength(1))
    expect(logUrls[0]).toContain('follow=true')
    expect(logUrls[0]).toContain('tailLines=500')

    push('2026-11-02T17:00:01Z \u001b[32mINFO\u001b[0m tique 1\n2026-11-02T17:00:03Z \u001b[32mINFO\u001b[0m tique 2\n2026-11-02T17:00')
    expect(await screen.findByText('INFO tique 2')).toBeInTheDocument()
    expect(log.textContent).not.toContain('\u001b')
    // A linha incompleta só aparece quando o resto chega.
    push(':05Z ERRO tique 3\n')
    expect(await screen.findByText('ERRO tique 3')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Buscar nos logs'), 'erro')
    expect(screen.getByText('1 linha')).toBeInTheDocument()
    expect(screen.queryByText('INFO tique 1')).not.toBeInTheDocument()
  })

  it('oferece a execução anterior e explica quando ela não existe', async () => {
    vi.stubGlobal('fetch', fakeApi({ previousMissing: true }))
    open()
    expect(await screen.findByText('Este container reiniciou 3 vezes.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Ver os logs da execução anterior' }))
    expect(await screen.findByText('Não há execução anterior deste container (ele não reiniciou).')).toBeInTheDocument()
    expect(logUrls.at(-1)).toContain('previous=true')
    expect(logUrls.at(-1)).not.toContain('follow')
  })

  it('não perde a última linha quando o stream termina sem quebra de linha', async () => {
    open()
    await screen.findByRole('log')
    await vi.waitFor(() => expect(logUrls).toHaveLength(1))
    push('unable to retrieve container logs for containerd://abc')
    close()
    expect(await screen.findByText('unable to retrieve container logs for containerd://abc')).toBeInTheDocument()
  })

  it('baixa os logs carregados', async () => {
    const createObjectURL = vi.fn(() => 'blob:x')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    open()
    await screen.findByRole('log')
    await vi.waitFor(() => expect(logUrls).toHaveLength(1))
    push('2026-11-02T17:00:01Z linha a\n')
    await screen.findByText('linha a')
    await userEvent.click(screen.getByRole('button', { name: 'Baixar' }))
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0]
    expect(await blob.text()).toBe('2026-11-02T17:00:01Z linha a\n')
  })
})
