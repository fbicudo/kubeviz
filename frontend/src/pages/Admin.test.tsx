import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import i18n from '@/i18n'

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })

let accounts: { name: string; admin: boolean; hasPassword: boolean; emails: string[]; current?: boolean }[]
let providers: { id: string; type: string; name: string; clientId: string; hasSecret: boolean; tenant?: string }[]
let requests: { method: string; url: string; body?: unknown }[]

function fakeApi() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (method !== 'GET') requests.push({ method, url, body })
    if (url === '/api/v1/auth/session') return json({ mode: 'local', loginMethods: ['password'], authenticated: true, admin: true, localUser: 'fabio' })
    if (url === '/api/v1/cluster') return json({ mode: 'local', reachable: true, server: 'x', version: 'v1.37.0' })
    if (url === '/api/v1/contexts') return json({ mode: 'local', contexts: [] })
    if (url === '/api/v1/admin/users' && method === 'GET') return json({ accounts, allowedDomains: ['empresa.com'] })
    if (url === '/api/v1/admin/users' && method === 'POST') {
      if (accounts.some((a) => a.name === body.name)) return json({ error: 'já existe uma conta com esse nome' }, 409)
      accounts.push({ name: body.name, admin: !!body.admin, hasPassword: !!body.password, emails: body.emails })
      return new Response(null, { status: 201 })
    }
    if (url.startsWith('/api/v1/admin/users/') && method === 'DELETE') {
      accounts = accounts.filter((a) => a.name !== decodeURIComponent(url.split('/').pop()!))
      return new Response(null, { status: 204 })
    }
    if (url === '/api/v1/admin/providers' && method === 'GET') return json({ providers })
    if (url.startsWith('/api/v1/admin/providers/') && method === 'PUT') {
      const id = url.split('/').pop()!
      providers = [...providers.filter((p) => p.id !== id), { id, type: body.type, name: body.name ?? 'Google', clientId: body.clientId, hasSecret: true }]
      return new Response(null, { status: 204 })
    }
    if (method !== 'GET') return new Response(null, { status: 204 })
    return json({}, 404)
  })
}

const renderAt = (path: string) => render(<App history={createMemoryHistory({ initialEntries: [path] })} />)

beforeEach(async () => {
  await i18n.changeLanguage('pt-BR')
  accounts = [
    { name: 'fabio', admin: true, hasPassword: true, emails: [], current: true },
    { name: 'bia', admin: false, hasPassword: false, emails: ['bia@gmail.com'] },
  ]
  providers = []
  requests = []
  vi.stubGlobal('fetch', fakeApi())
})
afterEach(() => vi.unstubAllGlobals())

describe('administração de usuários', () => {
  it('lista as contas e cria uma conta que entra pelo Google', async () => {
    const user = userEvent.setup()
    renderAt('/admin/users')
    const table = await screen.findByRole('table')
    const bia = (await within(table).findByText('bia')).closest('tr')!
    expect(within(bia).getByText('bia@gmail.com')).toBeInTheDocument()
    expect(within(bia).getByText('Usuário')).toBeInTheDocument()
    expect(within(table).getByText('(você)')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Novo usuário' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Usuário'), 'caio')
    await user.type(within(dialog).getByLabelText('E-mails para entrar com um provedor'), 'caio@gmail.com\ncaio@outlook.com')
    await user.click(within(dialog).getByRole('button', { name: 'Criar' }))
    expect(await within(table).findByText('caio')).toBeInTheDocument()
    expect(requests.at(-1)).toEqual({
      method: 'POST',
      url: '/api/v1/admin/users',
      body: { name: 'caio', emails: ['caio@gmail.com', 'caio@outlook.com'], admin: false },
    })
  })

  it('mostra o erro do servidor e remove contas com confirmação', async () => {
    const user = userEvent.setup()
    renderAt('/admin/users')
    await screen.findByText('bia')
    await user.click(screen.getByRole('button', { name: 'Novo usuário' }))
    let dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Usuário'), 'bia')
    await user.type(within(dialog).getByLabelText('E-mails para entrar com um provedor'), 'x@y.com')
    await user.click(within(dialog).getByRole('button', { name: 'Criar' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('já existe uma conta com esse nome')
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: 'Remover bia' }))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }))
    await vi.waitFor(() => expect(screen.queryByText('bia')).not.toBeInTheDocument())
  })

  it('não administradores não veem o menu de administração', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === '/api/v1/auth/session'
          ? json({ mode: 'local', loginMethods: ['password'], authenticated: true, localUser: 'bia' })
          : json({ mode: 'local', reachable: true, server: 'x', version: 'v1.37.0', contexts: [] }),
      ),
    )
    renderAt('/')
    await screen.findByRole('heading', { name: 'Visão geral' })
    expect(screen.queryByRole('link', { name: 'Usuários' })).not.toBeInTheDocument()
  })
})

describe('provedores de login', () => {
  it('mostra o endereço de retorno e salva o Google sem devolver o secret', async () => {
    const user = userEvent.setup()
    renderAt('/admin/providers')
    const google = (await screen.findByRole('heading', { name: 'Google' })).closest('section')!
    expect(within(google).getByText('Não configurado')).toBeInTheDocument()
    expect(within(google).getByLabelText('Endereço de retorno (cole no provedor)')).toHaveValue(`${window.location.origin}/auth/provider/google/callback`)
    expect(within(google).getByRole('link', { name: 'Google Cloud Console' })).toHaveAttribute('href', 'https://console.cloud.google.com/apis/credentials')
    const save = within(google).getByRole('button', { name: 'Salvar' })
    expect(save).toBeDisabled()
    await user.type(within(google).getByLabelText('Client ID'), '123.apps.googleusercontent.com')
    await user.type(within(google).getByLabelText('Client secret'), 'segredo-de-teste')
    await user.click(save)
    expect(await within(google).findByText('Ativo')).toBeInTheDocument()
    expect(requests.at(-1)).toEqual({
      method: 'PUT',
      url: '/api/v1/admin/providers/google',
      body: { type: 'google', name: 'Google', clientId: '123.apps.googleusercontent.com', clientSecret: 'segredo-de-teste' },
    })
    // O campo do secret volta vazio: o valor salvo nunca vem do servidor.
    expect(within(google).getByLabelText('Client secret')).toHaveValue('')
    expect(within(google).getByLabelText('Client secret')).toHaveAttribute('placeholder', '•••••• (mantém o atual)')
  })

  it('Microsoft pede o inquilino; GitHub e OIDC aparecem', async () => {
    renderAt('/admin/providers')
    const ms = (await screen.findByRole('heading', { name: 'Microsoft' })).closest('section')!
    expect(within(ms).getByLabelText('Inquilino (tenant)')).toHaveValue('common')
    expect(screen.getByRole('heading', { name: 'GitHub' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Adicionar provedor OIDC' })).toBeInTheDocument()
  })
})
