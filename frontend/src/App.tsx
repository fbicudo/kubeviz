import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, type RouterHistory } from '@tanstack/react-router'
import { useState } from 'react'
import { ApiError } from '@/lib/api'
import { sessionKey, useSession } from '@/lib/queries'
import { ThemeProvider } from '@/lib/theme'
import { Login } from '@/pages/Login'
import { makeRouter } from '@/router'
import '@/i18n'

const isUnauthorized = (e: unknown) => e instanceof ApiError && e.status === 401
// Erros 4xx (sem permissão, não encontrado…) não mudam ao repetir.
const isClientError = (e: unknown) => e instanceof ApiError && e.status >= 400 && e.status < 500

function makeQueryClient() {
  // Qualquer 401 (sessão expirada), em consulta ou ação, devolve o usuário à
  // tela de login.
  const onError = (error: unknown) => {
    if (isUnauthorized(error)) void qc.invalidateQueries({ queryKey: sessionKey })
  }
  const qc: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        retry: (count, error) => !isClientError(error) && count < 1,
      },
    },
  })
  return qc
}

function AuthGate({ history }: { history?: RouterHistory }) {
  const session = useSession()
  const [router] = useState(() => makeRouter(history))

  if (session.isPending) return null
  if (session.isError) {
    return <p className="p-6 text-critical">{session.error.message}</p>
  }
  if (!session.data.authenticated) return <Login mode={session.data.mode} />
  return <RouterProvider router={router} />
}

export function App({ history }: { history?: RouterHistory }) {
  const [queryClient] = useState(makeQueryClient)
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthGate history={history} />
      </QueryClientProvider>
    </ThemeProvider>
  )
}
