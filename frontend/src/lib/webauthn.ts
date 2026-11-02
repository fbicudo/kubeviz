// Passkeys (WebAuthn) no navegador: converte as opções do servidor (JSON com
// base64url) para a API do navegador e a resposta de volta para JSON.

import { apiGet, apiSend, type SessionInfo } from './api'

/** O navegador recusa passkeys em endereços IP e fora de contexto seguro (HTTPS ou localhost). */
export function passkeySupport(): 'ok' | 'browser' | 'ip' | 'insecure' {
  if (typeof window === 'undefined' || !('PublicKeyCredential' in window)) return 'browser'
  if (/^(\d{1,3}\.){3}\d{1,3}$|^\[/.test(window.location.hostname)) return 'ip'
  if (!window.isSecureContext) return 'insecure'
  return 'ok'
}

const fromB64 = (s: string): ArrayBuffer => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

const toB64 = (buf: ArrayBuffer | null): string | undefined => {
  if (!buf) return undefined
  let bin = ''
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type Descriptor = { id: string; type: string; transports?: string[] }
type JSONOptions = Record<string, unknown> & {
  challenge: string
  user?: { id: string; name: string; displayName: string }
  excludeCredentials?: Descriptor[]
  allowCredentials?: Descriptor[]
}

const descriptors = (list?: Descriptor[]) =>
  list?.map((d) => ({ ...d, id: fromB64(d.id) }) as PublicKeyCredentialDescriptor)

function creationOptions(o: JSONOptions): PublicKeyCredentialCreationOptions {
  return {
    ...(o as unknown as PublicKeyCredentialCreationOptions),
    challenge: fromB64(o.challenge),
    user: { ...o.user!, id: fromB64(o.user!.id) },
    excludeCredentials: descriptors(o.excludeCredentials),
  }
}

function requestOptions(o: JSONOptions): PublicKeyCredentialRequestOptions {
  return {
    ...(o as unknown as PublicKeyCredentialRequestOptions),
    challenge: fromB64(o.challenge),
    allowCredentials: descriptors(o.allowCredentials),
  }
}

/** Credencial em JSON (o formato que o servidor lê). */
function credentialJSON(cred: PublicKeyCredential) {
  const r = cred.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse
  return {
    id: cred.id,
    rawId: toB64(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64(r.clientDataJSON),
      attestationObject: 'attestationObject' in r ? toB64(r.attestationObject) : undefined,
      transports: typeof r.getTransports === 'function' ? r.getTransports() : undefined,
      authenticatorData: 'authenticatorData' in r ? toB64(r.authenticatorData) : undefined,
      signature: 'signature' in r ? toB64(r.signature) : undefined,
      userHandle: 'userHandle' in r ? toB64(r.userHandle) : undefined,
    },
  }
}

interface Ceremony {
  ceremony: string
  options: { publicKey: JSONOptions }
}

/** Entra com uma passkey deste endereço (sem digitar o usuário). */
export async function loginWithPasskey(): Promise<SessionInfo> {
  const { ceremony, options } = await apiSend<Ceremony>('POST', '/api/v1/auth/passkey/begin', {})
  const cred = (await navigator.credentials.get({ publicKey: requestOptions(options.publicKey) })) as PublicKeyCredential | null
  if (!cred) throw new DOMException('cancelado', 'NotAllowedError')
  return apiSend<SessionInfo>('POST', '/api/v1/auth/passkey/finish', { ceremony, credential: credentialJSON(cred) })
}

export interface PasskeyInfo {
  id: string
  name: string
  created: string
  lastUsed?: string
  /** Sincronizada entre dispositivos (iCloud, Google, gerenciador de senhas). */
  synced: boolean
}

export const listPasskeys = () => apiGet<{ passkeys: PasskeyInfo[] }>('/api/v1/me/passkeys')

/** Cadastra uma passkey neste dispositivo para a conta atual. */
export async function registerPasskey(name: string): Promise<void> {
  const { ceremony, options } = await apiSend<Ceremony>('POST', '/api/v1/me/passkeys/begin', {})
  const cred = (await navigator.credentials.create({ publicKey: creationOptions(options.publicKey) })) as PublicKeyCredential | null
  if (!cred) throw new DOMException('cancelado', 'NotAllowedError')
  await apiSend('POST', '/api/v1/me/passkeys/finish', { ceremony, name, credential: credentialJSON(cred) })
}

export const deletePasskey = (id: string) => apiSend('DELETE', `/api/v1/me/passkeys/${encodeURIComponent(id)}`, {})

/** Nome sugerido para a passkey: navegador e sistema (ex.: "Chrome no Linux"). */
export function suggestedPasskeyName(): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navegador'
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} · ${os}` : browser
}

/** O navegador recusou ou a pessoa cancelou (não é erro do servidor). */
export const cancelled = (e: unknown) => e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')
