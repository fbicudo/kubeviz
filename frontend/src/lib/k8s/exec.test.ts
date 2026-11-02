import { describe, expect, it } from 'vitest'
import { decodeFrame, encodeResize, encodeStdin, execUrl, exitCode, missingExecutable } from './exec'

describe('protocolo de exec', () => {
  it('monta a URL wss com o comando e o container', () => {
    const u = new URL(execUrl({ namespace: 'demo', pod: 'web-1', container: 'app', shell: 'sh' }, { protocol: 'https:', host: 'kv:4466' }))
    expect(u.protocol).toBe('wss:')
    expect(u.pathname).toBe('/api/k8s/api/v1/namespaces/demo/pods/web-1/exec')
    expect(u.searchParams.getAll('command')).toEqual(['sh'])
    expect(u.searchParams.get('tty')).toBe('true')
    const auto = new URL(execUrl({ namespace: 'demo', pod: 'p', container: 'c', shell: 'auto' }, { protocol: 'http:', host: 'x' }))
    expect(auto.protocol).toBe('ws:')
    expect(auto.searchParams.getAll('command')[0]).toBe('/bin/sh')
  })

  it('codifica entrada e redimensionamento com o byte do canal', () => {
    expect([...encodeStdin('ls\r')]).toEqual([0, 108, 115, 13])
    const r = encodeResize(120, 40)
    expect(r[0]).toBe(4)
    expect(JSON.parse(new TextDecoder().decode(r.subarray(1)))).toEqual({ Width: 120, Height: 40 })
  })

  it('decodifica saída e status final', () => {
    const out = decodeFrame(new Uint8Array([1, 104, 105]).buffer)
    expect(out.kind === 'output' && new TextDecoder().decode(out.data)).toBe('hi')
    const st = new TextEncoder().encode(
      JSON.stringify({ status: 'Failure', reason: 'NonZeroExitCode', details: { causes: [{ reason: 'ExitCode', message: '2' }] } }),
    )
    const dec = decodeFrame(new Uint8Array([3, ...st]).buffer)
    expect(dec.kind).toBe('status')
    expect(dec.kind === 'status' && exitCode(dec.status)).toBe(2)
    expect(exitCode({ status: 'Success' })).toBe(0)
    expect(decodeFrame(new Uint8Array([255]).buffer).kind).toBe('other')
  })

  it('reconhece shell inexistente na imagem', () => {
    const msg = 'Internal error occurred: ... OCI runtime exec failed: exec failed: unable to start container process: exec: "bash": executable file not found in $PATH'
    expect(missingExecutable({ status: 'Failure', message: msg })).toBe('bash')
    expect(missingExecutable({ status: 'Failure', message: 'outro erro' })).toBeUndefined()
  })
})
