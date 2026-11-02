import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import i18n from '@/i18n'

const json = (b: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(b), { status, headers })

// Senha usada apenas neste teste.
const SENHA = 'senha-de-teste-com-tamanho'

function fakeApi() {
  let loggedIn = false
  let failures = 0
  const session = () =>
    loggedIn
      ? { mode: 'local', loginMethods: ['password'], authenticated: true, localUser: 'fabio', user: { username: 'kubernetes-admin' } }
      : { mode: 'local', loginMethods: ['password'], authenticated: false }
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/v1/auth/session') return json(session())
    if (url === '/api/v1/auth/password' && init?.method === 'POST') {
      const { username, password } = JSON.parse(String(init.body)) as { username: string; password: string }
      if (failures >= 5) return json({ error: 'muitas tentativas' }, 429, { 'Retry-After': '900' })
      if (username !== 'fabio' || password !== SENHA) {
        failures++
        return json({ error: 'usuário ou senha inválidos' }, 401)
      }
      loggedIn = true
      return json(session())
    }
    if (url === '/api/v1/auth/logout') {
      loggedIn = false
      return new Response(null, { status: 204 })
    }
    if (url === '/api/v1/cluster') return json({ mode: 'local', reachable: true, server: 'x', version: 'v1.37.0' })
    if (url === '/api/v1/contexts') return json({ mode: 'local', contexts: [] })
    return json({}, 404)
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('pt-BR')
  vi.stubGlobal('fetch', fakeApi())
})
afterEach(() => vi.unstubAllGlobals())

const renderApp = () => render(<App history={createMemoryHistory({ initialEntries: ['/'] })} />)

async function fillAndSubmit(user: string, pass: string) {
  const u = await screen.findByLabelText('Usuário')
  const p = screen.getByLabelText('Senha')
  await userEvent.clear(u)
  await userEvent.type(u, user)
  await userEvent.clear(p)
  await userEvent.type(p, pass)
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }))
}

describe('login por usuário e senha', () => {
  it('mostra o formulário, recusa senha errada e entra com a certa', async () => {
    renderApp()
    expect(await screen.findByLabelText('Senha')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Usuário')).toHaveAttribute('autocomplete', 'username')
    expect(screen.queryByText(/link exibido no terminal/)).not.toBeInTheDocument()

    await fillAndSubmit('fabio', 'senha-errada-qualquer')
    expect(await screen.findByRole('alert')).toHaveTextContent('Usuário ou senha inválidos.')

    await fillAndSubmit('fabio', SENHA)
    expect(await screen.findByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
    // O cabeçalho mostra a conta local.
    expect(await screen.findByText('fabio')).toBeInTheDocument()
  })

  it('avisa quando há tentativas demais', async () => {
    renderApp()
    for (let i = 0; i < 5; i++) await fillAndSubmit('fabio', `errada-${i}-xxxxxxxx`)
    await fillAndSubmit('fabio', SENHA)
    expect(await screen.findByRole('alert')).toHaveTextContent('Muitas tentativas')
  })
})
