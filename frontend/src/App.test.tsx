import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import i18n from './i18n'
import ptBR from './i18n/locales/pt-BR.json'
import en from './i18n/locales/en.json'

function renderAt(path: string) {
  return render(<App history={createMemoryHistory({ initialEntries: [path] })} />)
}

// API falsa: dois contextos locais; o PUT troca o contexto atual.
function fakeApi() {
  let current = 'kind-dev'
  const info = () => ({
    mode: 'local',
    context: current,
    server: `https://${current}:6443`,
    reachable: true,
    version: current === 'kind-dev' ? 'v1.37.0' : 'v1.36.4',
    platform: 'linux/amd64',
  })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/v1/version') return json({ version: 'v0.0.0-test' })
    if (url === '/api/v1/cluster') return json(info())
    if (url === '/api/v1/contexts') {
      return json({
        mode: 'local',
        contexts: ['kind-dev', 'prod'].map((name) => ({ name, cluster: name, user: 'u', current: name === current })),
      })
    }
    if (url === '/api/v1/contexts/current' && init?.method === 'PUT') {
      current = (JSON.parse(String(init.body)) as { name: string }).name
      return json(info())
    }
    return json({ error: 'rota não encontrada' }, 404)
  })
}

let fetchMock: ReturnType<typeof fakeApi>

beforeEach(async () => {
  await i18n.changeLanguage('pt-BR')
  fetchMock = fakeApi()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe('App', () => {
  it('mostra a visão geral e o status do backend', async () => {
    renderAt('/')
    expect(await screen.findByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
    expect(await screen.findByText('Conectado · v0.0.0-test')).toBeInTheDocument()
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
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
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
