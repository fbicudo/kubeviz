import { createContext, useContext } from 'react'

export type Theme = 'dark' | 'light'

export interface ThemeContextValue {
  theme: Theme
  setTheme: (t: Theme) => void
  toggle: () => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme precisa estar dentro de <ThemeProvider>')
  return ctx
}
