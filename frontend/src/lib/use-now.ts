import { useEffect, useState } from 'react'

/** Horário atual, atualizado a cada `ms` (para idades como "3m" não congelarem). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
