import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import i18n from '@/i18n'

// Lista grande: 1.000 pods (o cenário de carga real tem 5.000, ver hack/scale).
const created = new Date(Date.now() - 60_000).toISOString()
const pod = (i: number) => ({
  metadata: { name: `app-${i}`, namespace: 'carga', uid: `uid-${i}`, creationTimestamp: created, managedFields: [{ manager: 'kwok' }] },
  spec: { nodeName: `kwok-node-${i % 10}`, containers: [{ name: 'app' }] },
  status: { phase: 'Running', podIP: `10.0.0.${i % 250}`, containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }] },
})
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })

beforeEach(async () => {
  await i18n.changeLanguage('pt-BR')
  // O jsdom não calcula layout: a área de rolagem da tabela tem 600 px de altura.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/auth/session') return json({ mode: 'local', authenticated: true })
      if (url === '/api/v1/cluster') return json({ mode: 'local', reachable: true, server: 'x', version: 'v1.37.0' })
      if (url === '/api/v1/contexts') return json({ mode: 'local', contexts: [] })
      if (url === '/api/k8s/api/v1/namespaces') return json({ kind: 'List', metadata: {}, items: [] })
      if (url === '/api/k8s/api/v1/pods') {
        return json({ kind: 'PodList', metadata: { resourceVersion: '1' }, items: Array.from({ length: 1000 }, (_, i) => pod(i)) })
      }
      return json({ kind: 'Status', code: 404 }, 404)
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('listas grandes', () => {
  it('desenha só uma parte das linhas, informa o total e filtra entre todas', async () => {
    const user = userEvent.setup()
    render(<App history={createMemoryHistory({ initialEntries: ['/pods'] })} />)
    expect(await screen.findByText('1000 de 1000 pods')).toBeInTheDocument()
    const table = screen.getByRole('table')
    expect(table).toHaveAttribute('aria-rowcount', '1001')
    const rendered = within(table)
      .getAllByRole('row')
      .filter((r) => Number(r.getAttribute('aria-rowindex')) > 1)
    expect(rendered.length).toBeGreaterThan(1)
    expect(rendered.length).toBeLessThan(100)

    // O filtro vale para todos os pods, não só os desenhados.
    await user.type(screen.getByRole('textbox', { name: /Filtrar/ }), 'app-999')
    expect(await screen.findByText('1 de 1000 pods')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'app-999' })).toBeInTheDocument()
  })
})
