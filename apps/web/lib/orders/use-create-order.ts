'use client'

import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  createCustomer,
  createOrder,
  type CreatedCustomerView,
  type CreatedOrderView,
  type CustomerCreateInput,
  fetchConversation,
  fetchProductInventory,
  type ProductInventoryView,
  QueryKeys
} from '@platform/api-client'
import type { CreateOrderInput } from '@platform/core/domain'

import { apiClient } from '../api'
import { fetchInventorySettings, type InventorySettingsView } from '../settings/inventory-requests'

// The hooks of the create-order drawer. Only the drawer loads this file.

// POST /orders. The server prices the order and plans the stock; what the screens show afterwards (the lists of orders, the stock
// of the products, the activity of the customer and the thread of the conversation) is read again.
export function useCreateOrder(
  storeId: string
): UseMutationResult<CreatedOrderView, Error, CreateOrderInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateOrderInput) => createOrder(apiClient, storeId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.orders.all(storeId) })
      void queryClient.invalidateQueries({ queryKey: QueryKeys.inventory.all(storeId) })
      void queryClient.invalidateQueries({ queryKey: QueryKeys.customers.all(storeId) })
    }
  })
}

// POST /customers from the drawer. The answer carries the possible duplicates; the creation is never blocked by them.
export function useCreateCustomer(
  storeId: string
): UseMutationResult<CreatedCustomerView, Error, CustomerCreateInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CustomerCreateInput) => createCustomer(apiClient, storeId, input),
    onSuccess: customer => {
      queryClient.setQueryData(QueryKeys.customers.byId(storeId, customer.id), customer)
      void queryClient.invalidateQueries({
        queryKey: [...QueryKeys.customers.all(storeId), 'list']
      })
    }
  })
}

// The stock of the products of the lines, every warehouse, for who may read the inventory: the choice of warehouses is
// made against it. A product that fails to load is left out (its line then has no stock block and the server plans it).
export function useLineStocks(
  storeId: string,
  productIds: readonly string[],
  enabled: boolean
): {
  byProduct: ReadonlyMap<string, ProductInventoryView>
  isLoading: boolean
  failed: ReadonlySet<string>
} {
  const results = useQueries({
    queries: productIds.map(productId => ({
      queryKey: QueryKeys.inventory.product(storeId, productId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchProductInventory(apiClient, storeId, productId, signal),
      enabled
    }))
  })
  const byProduct = new Map<string, ProductInventoryView>()
  const failed = new Set<string>()
  results.forEach((result, index) => {
    const productId = productIds[index] as string
    if (result.data !== undefined) byProduct.set(productId, result.data)
    else if (result.isError) failed.add(productId)
  })
  return { byProduct, isLoading: enabled && results.some(result => result.isPending), failed }
}

// The two switches of the store that decide how a line may be served (a split, negative stock). Settings → Inventory
// needs `settings:view`, so only a member who holds it can have the choice checked on the screen.
export function useStockSwitches(
  storeId: string,
  enabled: boolean
): UseQueryResult<InventorySettingsView> {
  return useQuery({
    queryKey: QueryKeys.inventorySettings.store(storeId),
    queryFn: ({ signal }) => fetchInventorySettings(apiClient, storeId, signal),
    enabled
  })
}

// The customer of the conversation an order is made from (the drawer opened by Shift+O or by a button of the thread)
export function useConversationCustomerId(
  storeId: string,
  conversationId: string | undefined
): { customerId: string | null; isLoading: boolean; isFailed: boolean } {
  const conversation = useQuery({
    queryKey: QueryKeys.conversations.byId(storeId, conversationId ?? ''),
    queryFn: ({ signal }) => fetchConversation(apiClient, storeId, conversationId ?? '', signal),
    enabled: conversationId !== undefined
  })
  return {
    customerId: conversation.data?.customer.id ?? null,
    isLoading: conversationId !== undefined && conversation.isPending,
    isFailed: conversation.isError
  }
}
