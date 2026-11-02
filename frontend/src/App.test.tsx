import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import i18n from './i18n'
import en from './i18n/locales/en.json'
import ptBR from './i18n/locales/pt-BR.json'

/** Abre um combobox pelo nome e escolhe uma opção, como um usuário faria. */
async function pick(combobox: string, option: string) {
  await userEvent.click(await screen.findByRole('combobox', { name: combobox }))
  await userEvent.click(await screen.findByRole('option', { name: option }))
}

function renderAt(path: string) {
  return render(<App history={createMemoryHistory({ initialEntries: [path] })} />)
}

interface FakeOptions {
  mode?: 'local' | 'in-cluster'
  authenticated?: boolean
  /** Usuário que só pode ler pods do namespace "demo". */
  restricted?: boolean
}

const created = new Date(Date.now() - 3 * 3600_000).toISOString()
const k8sPod = (name: string, namespace: string, state: object, ready = false, restartCount = 0) => ({
  metadata: { name, namespace, uid: `${namespace}/${name}`, creationTimestamp: created },
  spec: { nodeName: 'kind-control-plane', containers: [{ name: 'app' }] },
  status: { phase: 'Running', podIP: '10.244.0.9', containerStatuses: [{ name: 'app', ready, restartCount, state }] },
})
const demoPods = [
  k8sPod('web-1', 'demo', { running: {} }, true),
  k8sPod('quebrado', 'demo', { waiting: { reason: 'CrashLoopBackOff' } }, false, 5),
]
const allPods = [...demoPods, k8sPod('coredns', 'kube-system', { running: {} }, true)]
const list = (items: unknown[]) => ({ kind: 'List', metadata: {}, items })
const forbidden = (what: string) => ({
  kind: 'Status',
  status: 'Failure',
  code: 403,
  message: `${what} is forbidden: User "system:serviceaccount:demo:dev" cannot list resource`,
})

/**
 * API falsa: dois contextos locais; o PUT troca o contexto atual. No modo
 * in-cluster, o login aceita apenas "token-ana".
 */
function fakeApi({ mode = 'local', authenticated = true, restricted: startRestricted = false }: FakeOptions = {}) {
  let restricted = startRestricted
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
    if (url === '/api/k8s/api/v1/nodes') {
      if (restricted) return json(forbidden('nodes'), 403)
      return json(list([{ metadata: { name: 'kind-control-plane', uid: 'n1', creationTimestamp: created }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }]))
    }
    if (url === '/api/k8s/api/v1/namespaces') {
      if (restricted) return json(forbidden('namespaces'), 403)
      return json(list(['default', 'demo', 'kube-system'].map((name) => ({ metadata: { name, uid: name, creationTimestamp: created }, status: {} }))))
    }
    if (url === '/api/k8s/api/v1/pods') return restricted ? json(forbidden('pods'), 403) : json(list(allPods))
    if (url === '/api/k8s/api/v1/namespaces/demo/pods') return json(list(demoPods))
    if (url === '/api/v1/contexts/current' && method === 'PUT') {
      current = (JSON.parse(String(init?.body)) as { name: string }).name
      return json(info())
    }
    return json({ error: 'rota não encontrada' }, 404)
  })
  return { api, expireSession: () => (loggedIn = false), restrict: () => (restricted = true) }
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
    await pick('Cluster', 'prod')

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
    expect(await screen.findByRole('heading', { name: 'Entrar no KubeViz' })).toBeInTheDocument()
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
    await pick('Cluster', 'prod')
    expect(await screen.findByText(/link exibido no terminal/)).toBeInTheDocument()
  })
})

describe('pods', () => {
  it('a visão geral mostra nós prontos e pods com falha', async () => {
    renderAt('/')
    expect(await screen.findByText('1/1')).toBeInTheDocument()
    expect(await screen.findByText('2/3')).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: '1 pod com falha' })).toBeInTheDocument()
  })

  it('lista pods de todos os namespaces com status e reinícios', async () => {
    renderAt('/pods')
    expect(await screen.findByText('coredns')).toBeInTheDocument()
    expect(screen.getByText('3 de 3 pods')).toBeInTheDocument()
    expect(screen.getByText('CrashLoopBackOff')).toBeInTheDocument()
    expect(screen.getAllByText('3h').length).toBe(3)
  })

  it('filtra por nome', async () => {
    renderAt('/pods')
    await screen.findByText('coredns')
    await userEvent.type(screen.getByLabelText('Filtrar por nome ou namespace'), 'web')
    expect(screen.getByText('web-1')).toBeInTheDocument()
    expect(screen.queryByText('coredns')).not.toBeInTheDocument()
    expect(screen.getByText('1 de 3 pods')).toBeInTheDocument()
  })

  it('troca de namespace pela URL e pelo seletor', async () => {
    renderAt('/pods?ns=demo')
    expect(await screen.findByText('quebrado')).toBeInTheDocument()
    expect(screen.queryByText('coredns')).not.toBeInTheDocument()
    await pick('Namespace', 'Todos os namespaces')
    expect(await screen.findByText('coredns')).toBeInTheDocument()
  })

  it('busca namespace pelo teclado', async () => {
    renderAt('/pods')
    await screen.findByText('coredns')
    screen.getByRole('combobox', { name: 'Namespace' }).focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard('kube')
    expect(screen.queryByRole('option', { name: 'demo' })).not.toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByRole('combobox', { name: 'Namespace' })).toHaveTextContent('kube-system')
    expect(screen.queryByText('web-1')).not.toBeInTheDocument()
  })

  it('usuário restrito: recusa clara e acesso ao namespace permitido', async () => {
    useFake({ restricted: true })
    renderAt('/pods')
    expect(await screen.findByText('Sem permissão para listar pods em todos os namespaces')).toBeInTheDocument()
    expect(screen.getByText(/system:serviceaccount:demo:dev/)).toBeInTheDocument()

    // Sem permissão para listar namespaces: digita o nome e confirma com Enter.
    await userEvent.click(await screen.findByRole('combobox', { name: 'Namespace' }))
    await userEvent.keyboard('demo{Enter}')
    expect(await screen.findByText('web-1')).toBeInTheDocument()
  })
})

describe('troca de contexto', () => {
  it('não mostra dados da identidade anterior', async () => {
    // Depois da troca, o novo contexto age como usuário restrito.
    renderAt('/pods')
    expect(await screen.findByText('3 de 3 pods')).toBeInTheDocument()
    fake.restrict()
    await pick('Cluster', 'prod')
    expect(await screen.findByText('Sem permissão para listar pods em todos os namespaces')).toBeInTheDocument()
    expect(screen.queryByText(/de 3 pods/)).not.toBeInTheDocument()
    expect(screen.queryByText('coredns')).not.toBeInTheDocument()
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
