/** Erro devolvido pela API do Kubora (`{"error": "..."}`). */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { Accept: 'application/json', ...init?.headers } })
  if (!res.ok) {
    let message = res.statusText
    try {
      message = ((await res.json()) as { error?: string }).error ?? message
    } catch {
      // corpo não é JSON
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}

export interface VersionInfo {
  version: string
  commit: string
  date: string
  goVersion: string
}

export const getVersion = () => apiGet<VersionInfo>('/api/v1/version')
