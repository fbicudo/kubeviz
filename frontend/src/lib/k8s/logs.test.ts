import { describe, expect, it } from 'vitest'
import { appendLines, logUrl, splitTimestamp, stripAnsi, type LogLine } from './logs'

describe('logs', () => {
  it('remove cores e controles ANSI', () => {
    expect(stripAnsi('\u001b[32mINFO\u001b[0m tique 1')).toBe('INFO tique 1')
    expect(stripAnsi('\u001b[1;31;40mERRO\u001b[K fim')).toBe('ERRO fim')
  })

  it('separa o horário RFC3339 do início da linha', () => {
    expect(splitTimestamp('2026-11-02T17:01:27.123456789Z olá mundo')).toEqual({
      time: '2026-11-02T17:01:27.123456789Z',
      text: 'olá mundo',
    })
    expect(splitTimestamp('sem horário aqui')).toEqual({ text: 'sem horário aqui' })
  })

  it('mantém só as últimas linhas', () => {
    const mk = (n: number): LogLine[] => Array.from({ length: n }, (_, i) => ({ id: i, text: String(i) }))
    const out = appendLines(mk(8), mk(5).map((l) => ({ ...l, id: l.id + 100 })), 10)
    expect(out).toHaveLength(10)
    expect(out.at(-1)?.id).toBe(104)
  })

  it('monta a URL conforme as opções', () => {
    const base = { namespace: 'demo', pod: 'web-1', container: 'app', previous: false, tail: 500, follow: true }
    const u = new URL(logUrl(base), 'http://x')
    expect(u.pathname).toBe('/api/k8s/api/v1/namespaces/demo/pods/web-1/log')
    expect(Object.fromEntries(u.searchParams)).toEqual({ container: 'app', timestamps: 'true', follow: 'true', tailLines: '500' })

    const prev = new URL(logUrl({ ...base, previous: true }), 'http://x').searchParams
    expect(prev.get('previous')).toBe('true')
    expect(prev.get('follow')).toBeNull() // logs anteriores não são acompanhados

    const resume = new URL(logUrl(base, '2026-11-02T17:01:27Z'), 'http://x').searchParams
    expect(resume.get('sinceTime')).toBe('2026-11-02T17:01:27Z')
    expect(resume.get('tailLines')).toBeNull()
  })
})
