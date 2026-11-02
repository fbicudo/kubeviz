import { useEffect, useState, type ReactNode } from 'react'
import { ThemeContext, type Theme } from './theme-context'
import { safeStorage } from './utils'

const STORAGE_KEY = 'kubeviz.theme'

/** Tema escuro é o padrão (decisão P13); a escolha do usuário fica salva. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() =>
    safeStorage.get(STORAGE_KEY) === 'light' ? 'light' : 'dark',
  )

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    safeStorage.set(STORAGE_KEY, theme)
  }, [theme])

  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  return <ThemeContext value={{ theme, setTheme, toggle }}>{children}</ThemeContext>
}
