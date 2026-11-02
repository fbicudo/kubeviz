import { Outlet } from '@tanstack/react-router'
import { useState } from 'react'
import { safeStorage } from '@/lib/utils'
import { Header } from './Header'
import { Sidebar } from './Sidebar'

const COLLAPSED_KEY = 'kubeviz.sidebar.collapsed'

export function AppShell() {
  const [collapsed, setCollapsed] = useState(() => safeStorage.get(COLLAPSED_KEY) === '1')

  const toggle = () =>
    setCollapsed((c) => {
      safeStorage.set(COLLAPSED_KEY, c ? '0' : '1')
      return !c
    })

  return (
    <div className="flex h-full">
      <Sidebar collapsed={collapsed} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header onToggleSidebar={toggle} />
        <main className="flex-1 overflow-auto p-4">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
