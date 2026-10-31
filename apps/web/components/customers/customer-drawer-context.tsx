'use client'

import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState
} from 'react'

import { CustomerDrawer } from './customer-drawer'

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
      <CustomerDrawer customerId={customerId} isOpen={isOpen} onClose={() => setOpen(false)} />
    </CustomerDrawerContext.Provider>
  )
}

export function useCustomerDrawer(): CustomerDrawerValue {
  const value = useContext(CustomerDrawerContext)
  if (value === null) throw new Error('useCustomerDrawer needs a CustomerDrawerProvider above it')
  return value
}
