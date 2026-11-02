import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import i18n from './i18n'
import en from './i18n/locales/en.json'
import ptBR from './i18n/locales/pt-BR.json'

function renderAt(path: string) {
  return render(<App history={createMemoryHistory({ initialEntries: [path] })} />)
}

interface FakeOptions {
  mode?: 'local' | 'in-cluster'
  authenticated?: boolean
}

/**
 * API falsa: dois contextos locais; o PUT troca o contexto atual. No modo
 * in-cluster, o login aceita apenas "token-ana".
 */
function fakeApi({ mode = 'local', authenticated = true }: FakeOptions = {}) {
  let current = 'kind-dev'
  let loggedIn = authenticated
  const info = () => ({
    mode,
    context: current,
    server: `https://${current}:6443`,
    reachable: true,
    version: current === 'kind-dev' ? 'v1.37.0' : 'v1.36.4',
    platform: 'linux/amd64',
  })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const session = () =>
    loggedIn
      ? { mode, authenticated: true, user: { username: mode === 'local' ? 'kubernetes-admin' : 'ana' } }
      : { mode, authenticated: false }

  const api = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/v1/version') return json({ version: 'v0.0.0-test' })
    if (url === '/api/v1/auth/session') return json(session())
    if (url === '/api/v1/auth/login' && method === 'POST') {
      const { token } = JSON.parse(String(init?.body)) as { token: string }
      if (token !== 'token-ana') return json({ error: 'token inválido ou expirado' }, 401)
      loggedIn = true
      return json(session())
    }
    if (url === '/api/v1/auth/logout' && method === 'POST') {
      loggedIn = false
      return new Response(null, { status: 204 })
    }
    if (!loggedIn) return json({ error: 'sessão ausente ou expirada' }, 401)
    if (url === '/api/v1/cluster') return json(info())
    if (url === '/api/v1/contexts') {
      return json({
        mode,
        contexts: ['kind-dev', 'prod'].map((name) => ({ name, cluster: name, user: 'u', current: name === current })),
      })
    }
    if (url === '/api/v1/contexts/current' && method === 'PUT') {
      current = (JSON.parse(String(init?.body)) as { name: string }).name
      return json(info())
    }
    return json({ error: 'rota não encontrada' }, 404)
  })
  return { api, expireSession: () => (loggedIn = false) }
}

let fake: ReturnType<typeof fakeApi>

function useFake(opts?: FakeOptions) {
  fake = fakeApi(opts)
  vi.stubGlobal('fetch', fake.api)
}

beforeEach(async () => {
  await i18n.changeLanguage('pt-BR')
  useFake()
})

afterEach(() => vi.unstubAllGlobals())

describe('App autenticado', () => {
  it('mostra a visão geral, o backend e o usuário', async () => {
    renderAt('/')
    expect(await screen.findByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
    expect(await screen.findByText('Conectado · v0.0.0-test')).toBeInTheDocument()
    expect(await screen.findByText('kubernetes-admin')).toBeInTheDocument()
  })

  it('mostra o cluster conectado', async () => {
    renderAt('/')
    expect(await screen.findByText('v1.37.0 · linux/amd64')).toBeInTheDocument()
    expect(await screen.findByLabelText('Cluster acessível')).toBeInTheDocument()
  })

  it('troca de contexto pelo cabeçalho enviando JSON', async () => {
    renderAt('/')
    const select = await screen.findByRole('combobox', { name: 'Cluster' })
    await screen.findByRole('option', { name: 'prod' })
    await userEvent.selectOptions(select, 'prod')

    expect(await screen.findByText('v1.36.4 · linux/amd64')).toBeInTheDocument()
    const put = fake.api.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(put?.[1]?.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(put?.[1]?.body).toBe(JSON.stringify({ name: 'prod' }))
  })

  it('navega pelo menu lateral', async () => {
    renderAt('/')
    await userEvent.click(await screen.findByRole('link', { name: 'Pods' }))
    expect(await screen.findByRole('heading', { name: 'Pods' })).toBeInTheDocument()
  })

  it('usa tema escuro por padrão e alterna para claro', async () => {
    renderAt('/')
    const toggle = await screen.findByRole('button', { name: 'Alternar tema' })
    expect(document.documentElement.dataset.theme).toBe('dark')
    await userEvent.click(toggle)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('troca o idioma para inglês', async () => {
    renderAt('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Idioma' }))
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument()
  })

  it('sai e volta à tela de entrada', async () => {
    renderAt('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Sair' }))
    expect(await screen.findByRole('heading', { name: 'Entrar no Kubora' })).toBeInTheDocument()
  })
})

describe('autenticação', () => {
  it('no modo local sem sessão, orienta a usar o link do terminal', async () => {
    useFake({ mode: 'local', authenticated: false })
    renderAt('/')
    expect(await screen.findByText(/link exibido no terminal/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('no modo in-cluster, recusa token inválido e entra com token válido', async () => {
    useFake({ mode: 'in-cluster', authenticated: false })
    renderAt('/')
    const field = await screen.findByLabelText('Token de acesso ao Kubernetes')
    const submit = screen.getByRole('button', { name: 'Entrar' })

    await userEvent.type(field, 'token-errado')
    await userEvent.click(submit)
    expect(await screen.findByRole('alert')).toHaveTextContent('Token inválido ou expirado.')

    await userEvent.clear(field)
    await userEvent.type(field, 'token-ana')
    await userEvent.click(submit)
    expect(await screen.findByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
    expect(await screen.findByText('ana')).toBeInTheDocument()
  })

  it('volta à tela de entrada quando a sessão expira', async () => {
    renderAt('/')
    await screen.findByText('v1.37.0 · linux/amd64')

    // A próxima ação recebe 401 do backend.
    fake.expireSession()
    await screen.findByRole('option', { name: 'prod' })
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Cluster' }), 'prod')
    expect(await screen.findByText(/link exibido no terminal/)).toBeInTheDocument()
  })
})

describe('traduções', () => {
  const keys = (o: object, prefix = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      typeof v === 'object' ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
    )

  it('pt-BR e en têm as mesmas chaves', () => {
    expect(keys(en).sort()).toEqual(keys(ptBR).sort())
  })
})
