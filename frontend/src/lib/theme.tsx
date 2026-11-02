import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { safeStorage } from './utils'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'kubora.theme'

interface ThemeContextValue {
  theme: Theme
  setTheme: (t: Theme) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

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

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme precisa estar dentro de <ThemeProvider>')
  return ctx
}
