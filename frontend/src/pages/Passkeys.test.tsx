import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import i18n from '@/i18n'

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const buf = (...bytes: number[]) => new Uint8Array(bytes).buffer
const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

let loggedIn: boolean
let passkeys: { id: string; name: string; created: string; synced: boolean }[]
let posted: { url: string; body: Record<string, unknown> }[]
let finishStatus: number

function fakeApi() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    if (init?.method === 'POST' || init?.method === 'DELETE') posted.push({ url, body })
    if (url === '/api/v1/auth/session') {
      return json(
        loggedIn
          ? { mode: 'local', loginMethods: ['password'], authenticated: true, localUser: 'fabio', admin: true }
          : { mode: 'local', loginMethods: ['password'], passkeys: true, authenticated: false },
      )
    }
    if (url === '/api/v1/auth/passkey/begin') return json({ ceremony: 'c1', options: { publicKey: { challenge: b64('desafio'), rpId: 'localhost', userVerification: 'required' } } })
    if (url === '/api/v1/auth/passkey/finish') {
      if (finishStatus !== 200) return json({ error: 'passkey não reconhecida' }, finishStatus)
      loggedIn = true
      return json({ mode: 'local', loginMethods: ['password'], authenticated: true, localUser: 'fabio' })
    }
    if (url === '/api/v1/me/passkeys' && !init?.method) return json({ passkeys })
    if (url === '/api/v1/me/passkeys/begin') {
      return json({
        ceremony: 'c2',
        options: {
          publicKey: {
            challenge: b64('outro'),
            rp: { id: 'localhost', name: 'KubeViz' },
            user: { id: b64('conta-123'), name: 'fabio', displayName: 'fabio' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            excludeCredentials: [{ type: 'public-key', id: b64('antiga') }],
          },
        },
      })
    }
    if (url === '/api/v1/me/passkeys/finish') {
      if (finishStatus !== 200) return json({ error: 'esta passkey já está cadastrada' }, finishStatus)
      passkeys.push({ id: 'nova', name: String(body.name), created: new Date().toISOString(), synced: true })
      return new Response(null, { status: 201 })
    }
    if (url.startsWith('/api/v1/me/passkeys/') && init?.method === 'DELETE') {
      passkeys = passkeys.filter((p) => p.id !== url.split('/').pop())
      return new Response(null, { status: 204 })
    }
    if (url === '/api/v1/cluster') return json({ mode: 'local', reachable: true, server: 'x', version: 'v1.37.0' })
    if (url === '/api/v1/contexts') return json({ mode: 'local', contexts: [] })
    return json({}, 404)
  })
}

const credential = (extra: Record<string, ArrayBuffer>) => ({
  id: 'cred',
  rawId: buf(1, 2, 3),
  type: 'public-key',
  authenticatorAttachment: 'platform',
  getClientExtensionResults: () => ({}),
  response: { clientDataJSON: buf(123, 125), ...extra },
})

let get: ReturnType<typeof vi.fn>
let create: ReturnType<typeof vi.fn>

beforeEach(async () => {
  await i18n.changeLanguage('pt-BR')
  loggedIn = false
  passkeys = []
  posted = []
  finishStatus = 200
  get = vi.fn(async () => credential({ authenticatorData: buf(9), signature: buf(8), userHandle: buf(7) }))
  create = vi.fn(async () => ({ ...credential({ attestationObject: buf(6) }), response: { clientDataJSON: buf(1), attestationObject: buf(6), getTransports: () => ['internal'] } }))
  vi.stubGlobal('fetch', fakeApi())
  vi.stubGlobal('PublicKeyCredential', class {})
  vi.stubGlobal('isSecureContext', true)
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get, create } })
})
afterEach(() => vi.unstubAllGlobals())

const renderAt = (path: string) => render(<App history={createMemoryHistory({ initialEntries: [path] })} />)

describe('entrar com passkey', () => {
  it('pede a passkey ao navegador e entra sem usuário nem senha', async () => {
    const user = userEvent.setup()
    renderAt('/')
    await user.click(await screen.findByRole('button', { name: 'Entrar com passkey' }))
    expect(await screen.findByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
    const opts = get.mock.calls[0][0].publicKey as PublicKeyCredentialRequestOptions
    expect(new TextDecoder().decode(opts.challenge as ArrayBuffer)).toBe('desafio')
    expect(opts.userVerification).toBe('required')
    const finish = posted.find((p) => p.url === '/api/v1/auth/passkey/finish')!
    expect(finish.body).toMatchObject({ ceremony: 'c1', credential: { id: 'cred', rawId: 'AQID', response: { signature: 'CA', userHandle: 'Bw' } } })
  })

  it('passkey desconhecida: explica; cancelar não mostra erro', async () => {
    const user = userEvent.setup()
    finishStatus = 401
    renderAt('/')
    await user.click(await screen.findByRole('button', { name: 'Entrar com passkey' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Passkey não reconhecida')
    get.mockRejectedValueOnce(new DOMException('cancelado', 'NotAllowedError'))
    await user.click(screen.getByRole('button', { name: 'Entrar com passkey' }))
    await vi.waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('não aparece em navegador sem suporte', async () => {
    vi.stubGlobal('PublicKeyCredential', undefined)
    // @ts-expect-error remove a API do navegador simulado
    delete window.PublicKeyCredential
    renderAt('/')
    await screen.findByLabelText('Senha')
    expect(screen.queryByRole('button', { name: 'Entrar com passkey' })).not.toBeInTheDocument()
  })
})

describe('minha conta', () => {
  beforeEach(() => {
    loggedIn = true
    passkeys = [{ id: 'antiga', name: 'Celular', created: new Date(Date.now() - 86_400_000).toISOString(), synced: false }]
  })

  it('cadastra uma passkey com o nome escolhido e remove outra', async () => {
    const user = userEvent.setup()
    renderAt('/account')
    const list = await screen.findByRole('list', { name: 'Passkeys' })
    expect(await within(list).findByText('Celular')).toBeInTheDocument()
    expect(within(list).getByText(/nunca usada/)).toBeInTheDocument()

    const name = screen.getByLabelText('Nome da passkey')
    await user.clear(name)
    await user.type(name, 'Notebook do trabalho')
    await user.click(screen.getByRole('button', { name: 'Adicionar passkey' }))
    expect(await within(list).findByText('Notebook do trabalho')).toBeInTheDocument()
    expect(screen.getByText(/Passkey cadastrada/)).toBeInTheDocument()
    const opts = create.mock.calls[0][0].publicKey as PublicKeyCredentialCreationOptions
    expect(new TextDecoder().decode(opts.user.id as ArrayBuffer)).toBe('conta-123')
    expect(new TextDecoder().decode(opts.excludeCredentials![0].id as ArrayBuffer)).toBe('antiga')
    expect(posted.find((p) => p.url === '/api/v1/me/passkeys/finish')!.body).toMatchObject({
      ceremony: 'c2',
      name: 'Notebook do trabalho',
      credential: { response: { attestationObject: 'Bg', transports: ['internal'] } },
    })

    await user.click(screen.getByRole('button', { name: 'Remover Celular' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Excluir' }))
    await vi.waitFor(() => expect(within(list).queryByText('Celular')).not.toBeInTheDocument())
  })

  it('dispositivo com passkey já cadastrada e endereço por IP', async () => {
    const user = userEvent.setup()
    finishStatus = 409
    renderAt('/account')
    await user.click(await screen.findByRole('button', { name: 'Adicionar passkey' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Este dispositivo já tem uma passkey desta conta.')
  })

  it('o nome no cabeçalho leva a Minha conta', async () => {
    renderAt('/')
    expect(await screen.findByRole('link', { name: 'fabio' })).toHaveAttribute('href', '/account')
  })
})
