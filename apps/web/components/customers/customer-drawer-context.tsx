'use client'

import dynamic from 'next/dynamic'
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState
} from 'react'

// The drawer, its timeline and its sheet load when a profile is first opened, not with the page: the
// inbox has a script budget (apps/web-e2e/lighthouse/budgets.ts) and most sessions never open one.
const CustomerDrawer = dynamic(
  () => import('./customer-drawer').then(module => module.CustomerDrawer),
  { ssr: false }
)

interface CustomerDrawerValue {
  openCustomer: (customerId: string) => void
}

const CustomerDrawerContext = createContext<CustomerDrawerValue | null>(null)

// Holds which customer the profile drawer shows (null: closed) for everything under the store, so the
// inbox, the customers page and the shortcuts open the same drawer.
export function CustomerDrawerProvider({ children }: { children: ReactNode }): ReactElement {
  // The id stays after closing so the content is there while the panel slides out
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [isOpen, setOpen] = useState(false)
  const openCustomer = useCallback((id: string) => {
    setCustomerId(id)
    setOpen(true)
  }, [])
  const value = useMemo(() => ({ openCustomer }), [openCustomer])
  return (
    <CustomerDrawerContext.Provider value={value}>
      {children}
      {/* Not mounted until the first open, so nothing is fetched or downloaded before */}
      {customerId === null ? null : (
        <CustomerDrawer customerId={customerId} isOpen={isOpen} onClose={() => setOpen(false)} />
      )}
    </CustomerDrawerContext.Provider>
  )
}

export function useCustomerDrawer(): CustomerDrawerValue {
  const value = useContext(CustomerDrawerContext)
  if (value === null) throw new Error('useCustomerDrawer needs a CustomerDrawerProvider above it')
  return value
}
