// Protocolo de exec do Kubernetes por WebSocket (v5.channel.k8s.io / v4).
// Cada mensagem binária começa com um byte de canal:
//   0 entrada · 1 saída · 2 erros · 3 status final (JSON) · 4 tamanho do terminal · 255 fechamento (v5)

export const EXEC_PROTOCOLS = ['v5.channel.k8s.io', 'v4.channel.k8s.io']

export const Channel = { stdin: 0, stdout: 1, stderr: 2, status: 3, resize: 4, close: 255 } as const

export type Shell = 'auto' | 'sh' | 'bash'

/** Comando de cada opção de shell; "auto" usa bash quando existe. */
export function shellCommand(shell: Shell): string[] {
  if (shell === 'auto') return ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi']
  return [shell]
}

export interface ExecTarget {
  namespace: string
  pod: string
  container: string
  shell: Shell
}

/** Endereço do WebSocket na mesma origem da página (ws: ou wss:). */
export function execUrl(t: ExecTarget, loc: { protocol: string; host: string } = window.location): string {
  const p = new URLSearchParams({ container: t.container, stdin: 'true', stdout: 'true', stderr: 'true', tty: 'true' })
  for (const c of shellCommand(t.shell)) p.append('command', c)
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${loc.host}/api/k8s/api/v1/namespaces/${encodeURIComponent(t.namespace)}/pods/${encodeURIComponent(t.pod)}/exec?${p}`
}

const enc = new TextEncoder()

function frame(channel: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(payload.length + 1)
  out[0] = channel
  out.set(payload, 1)
  return out
}

export const encodeStdin = (text: string) => frame(Channel.stdin, enc.encode(text))

export const encodeResize = (cols: number, rows: number) =>
  frame(Channel.resize, enc.encode(JSON.stringify({ Width: cols, Height: rows })))

export interface ExecStatus {
  status?: 'Success' | 'Failure'
  message?: string
  reason?: string
  details?: { causes?: { reason?: string; message?: string }[] }
}

export type DecodedFrame =
  | { kind: 'output'; data: Uint8Array }
  | { kind: 'status'; status: ExecStatus }
  | { kind: 'other' }

export function decodeFrame(buf: ArrayBuffer): DecodedFrame {
  const bytes = new Uint8Array(buf)
  if (bytes.length === 0) return { kind: 'other' }
  const payload = bytes.subarray(1)
  switch (bytes[0]) {
    case Channel.stdout:
    case Channel.stderr:
      return { kind: 'output', data: payload }
    case Channel.status:
      try {
        return { kind: 'status', status: JSON.parse(new TextDecoder().decode(payload)) as ExecStatus }
      } catch {
        return { kind: 'other' }
      }
    default:
      return { kind: 'other' }
  }
}

/** Shell pedido que não existe na imagem (ex.: bash em imagens alpine). */
export function missingExecutable(s: ExecStatus): string | undefined {
  return /exec: "([^"]+)": executable file not found/.exec(s.message ?? '')?.[1]
}

/** Código de saída informado no status final (ExitCode nas causas). */
export function exitCode(s: ExecStatus): number | undefined {
  if (s.status === 'Success') return 0
  const c = s.details?.causes?.find((x) => x.reason === 'ExitCode')
  return c?.message !== undefined ? Number(c.message) : undefined
}
