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

beforeEach(async () => {
  await i18n.changeLanguage('pt-BR')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ version: 'v0.0.0-test' }), { status: 200 })),
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('App', () => {
  it('mostra a visão geral e o status do backend', async () => {
    renderAt('/')
    expect(await screen.findByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
    expect(await screen.findByText('Conectado · v0.0.0-test')).toBeInTheDocument()
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
