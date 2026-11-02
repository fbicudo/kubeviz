/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Garante contraste WCAG 2.1 AA (4,5:1) entre as cores de texto e os fundos
// dos dois temas definidos em index.css.

// O Vitest roda a partir da pasta frontend/.
const css = readFileSync('src/index.css', 'utf8')

function tokens(theme: 'dark' | 'light'): Record<string, string> {
  const block = new RegExp(`\\[data-theme='${theme}'\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]))
}

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const texts = ['foreground', 'muted', 'subtle', 'accent', 'ok', 'warn', 'critical', 'info']
const backgrounds = ['background', 'surface', 'surface-raised']

describe.each(['dark', 'light'] as const)('tema %s', (theme) => {
  const t = tokens(theme)

  it.each(texts.flatMap((fg) => backgrounds.map((bg) => [fg, bg])))('%s sobre %s ≥ 4,5:1', (fg, bg) => {
    expect(t[fg], `token --${fg} ausente`).toBeDefined()
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5)
  })

  it('texto do botão primário sobre a cor de destaque ≥ 4,5:1', () => {
    expect(contrast(t['accent-foreground'], t.accent)).toBeGreaterThanOrEqual(4.5)
  })
})
