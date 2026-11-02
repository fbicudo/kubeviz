/**
 * Idade compacta no estilo do kubectl: 45s, 12m, 5h, 3d, 2y. Recebe "agora"
 * como parâmetro para facilitar testes.
 */
export function age(timestamp: string | undefined, now = Date.now()): string {
  if (!timestamp) return '—'
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000))
  if (seconds < 120) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 120) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 730) return `${days}d`
  return `${Math.floor(days / 365)}y`
}
