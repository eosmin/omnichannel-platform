'use client'

import dynamic from 'next/dynamic'
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState
} from 'react'

// The drawer, its search and its forms load when it is first opened, not with the page: the inbox and the orders page
// have a script budget (apps/web-e2e/lighthouse/budgets.ts) and most sessions never create an order.
const CreateOrderDrawer = dynamic(
  () => import('./create-order-drawer').then(module => module.CreateOrderDrawer),
  { ssr: false }
)

const EditOrderDrawer = dynamic(
  () => import('./edit-order-drawer').then(module => module.EditOrderDrawer),
  { ssr: false }
)

export interface OpenCreateOrder {
  // The customer the order is for; left out, the drawer takes the one of the conversation or asks for one
  customerId?: string
  // The conversation the order comes from: the chat stays visible beside the drawer, and the order is linked to it
  conversationId?: string
}

interface OrderDrawerValue {
  openCreate: (options?: OpenCreateOrder) => void
  // The items, the shipping fee and the discount of an order that exists
  openEdit: (orderId: string) => void
}

const OrderDrawerContext = createContext<OrderDrawerValue | null>(null)

interface Request extends OpenCreateOrder {
  // A new key per opening: the form starts empty every time
  openingId: number
}

// Holds whether the create-order and the edit-order drawers are open, and for whom, for everything under the store: the orders page, the
// shortcut of the open conversation and the buttons of the composer open the same drawer.
export function OrderDrawerProvider({ children }: { children: ReactNode }): ReactElement {
  const [request, setRequest] = useState<Request | null>(null)
  const [isOpen, setOpen] = useState(false)
  // Asking again while the drawer is open (the shortcut, a button) must not start a new, empty form over the one in use
  const isOpenRef = useRef(false)
  isOpenRef.current = isOpen
  const openCreate = useCallback((options: OpenCreateOrder = {}) => {
    if (isOpenRef.current) return
    setRequest(previous => ({ ...options, openingId: (previous?.openingId ?? 0) + 1 }))
    setOpen(true)
  }, [])
  const [editing, setEditing] = useState<{
    orderId: string
    isOpen: boolean
    openingId: number
  } | null>(null)
  const openEdit = useCallback((orderId: string) => {
    setEditing(previous => ({ orderId, isOpen: true, openingId: (previous?.openingId ?? 0) + 1 }))
  }, [])
  const value = useMemo(() => ({ openCreate, openEdit }), [openCreate, openEdit])
  return (
    <OrderDrawerContext.Provider value={value}>
      {children}
      {/* Not mounted until the first open, so nothing is fetched or downloaded before */}
      {request === null ? null : (
        <CreateOrderDrawer
          key={request.openingId}
          customerId={request.customerId}
          conversationId={request.conversationId}
          isOpen={isOpen}
          onClose={() => setOpen(false)}
        />
      )}
      {editing === null ? null : (
        <EditOrderDrawer
          key={editing.openingId}
          orderId={editing.orderId}
          isOpen={editing.isOpen}
          onClose={() =>
            setEditing(current => (current === null ? null : { ...current, isOpen: false }))
          }
        />
      )}
    </OrderDrawerContext.Provider>
  )
}

export function useOrderDrawer(): OrderDrawerValue {
  const value = useContext(OrderDrawerContext)
  if (value === null) throw new Error('useOrderDrawer needs an OrderDrawerProvider above it')
  return value
}
