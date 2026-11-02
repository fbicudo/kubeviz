import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import i18n from '@/i18n'

const created = new Date(Date.now() - 3600_000).toISOString()
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const deployment = (replicas: number) => ({
  metadata: { name: 'web', namespace: 'demo', uid: 'uid-web', creationTimestamp: created, resourceVersion: '5' },
  spec: { replicas },
})

let patches: { url: string; body: string; contentType: string }[] = []
let conflictUntilForced = false

function fakeApi() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('watch=1')) return json({}, 404)
    if (url === '/api/v1/auth/session') return json({ mode: 'local', loginMethods: ['link'], authenticated: true })
    if (url === '/api/v1/cluster') return json({ mode: 'local', reachable: true, server: 'x', version: 'v1.37.0' })
    if (url === '/api/v1/contexts') return json({ mode: 'local', contexts: [] })
    if (url.startsWith('/api/k8s/apis/apps/v1/namespaces/demo/deployments?fieldSelector')) {
      return json({ kind: 'List', metadata: { resourceVersion: '5' }, items: [deployment(2)] })
    }
    if (init?.method === 'PATCH') {
      patches.push({ url, body: String(init.body), contentType: new Headers(init.headers).get('Content-Type') ?? '' })
      if (conflictUntilForced && !url.includes('force=true')) {
        return json(
          {
            kind: 'Status',
            reason: 'Conflict',
            message: 'Apply failed with 1 conflict',
            details: { causes: [{ field: '.spec.replicas', message: 'conflict with "kubectl-client-side-apply"' }] },
          },
          409,
        )
      }
      // O cluster "aplica" e devolve 3 réplicas (simula a alteração).
      return json({ apiVersion: 'apps/v1', kind: 'Deployment', ...deployment(3) })
    }
    return json({ kind: 'Status', code: 404, message: 'not found' }, 404)
  })
}

beforeEach(async () => {
  patches = []
  conflictUntilForced = false
  await i18n.changeLanguage('pt-BR')
  vi.stubGlobal('fetch', fakeApi())
})
afterEach(() => vi.unstubAllGlobals())

const open = async () => {
  render(<App history={createMemoryHistory({ initialEntries: ['/view/apps/v1/deployments/web?ns=demo&tab=yaml'] })} />)
  await userEvent.click(await screen.findByRole('button', { name: 'Editar' }))
  await screen.findByLabelText('YAML de web')
}

describe('edição de YAML', () => {
  it('validar mostra o diff do dry-run; aplicar só depois de validar', async () => {
    await open()
    const apply = screen.getByRole('button', { name: 'Aplicar alterações' })
    expect(apply).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Validar' }))
    expect(await screen.findByText('Válido. O cluster aplicaria estas mudanças:')).toBeInTheDocument()
    expect(screen.getByText('replicas: 3')).toBeInTheDocument()
    expect(patches[0].url).toContain('dryRun=All')
    expect(patches[0].contentType).toBe('application/apply-patch+yaml')
    expect(patches[0].body).toContain('name: web')
    expect(patches[0].body).not.toContain('resourceVersion')

    await userEvent.click(apply)
    await vi.waitFor(() => expect(patches).toHaveLength(2))
    expect(patches[1].url).not.toContain('dryRun')
    // Depois de aplicar, volta para a visualização.
    expect(await screen.findByRole('button', { name: 'Editar' })).toBeInTheDocument()
  })

  it('conflito de dono: explica e permite validar forçando', async () => {
    conflictUntilForced = true
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }))
    expect(await screen.findByText('Conflito: outro gerenciador controla estes campos')).toBeInTheDocument()
    expect(screen.getByText(/kubectl-client-side-apply/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Validar forçando' }))
    expect(await screen.findByRole('button', { name: 'Aplicar forçando' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Aplicar forçando' }))
    await vi.waitFor(() => expect(patches.at(-1)?.url).toContain('force=true'))
    expect(patches.at(-1)?.url).not.toContain('dryRun')
  })

  it('cancelar volta sem enviar nada', async () => {
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(await screen.findByRole('button', { name: 'Editar' })).toBeInTheDocument()
    expect(patches).toHaveLength(0)
  })
})
