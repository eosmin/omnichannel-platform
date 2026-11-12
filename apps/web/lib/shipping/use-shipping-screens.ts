'use client'

import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  addPickupShipments,
  type CarrierConnectionView,
  fetchAllCarrierConnections,
  cancelPickup,
  cancelShipment,
  checkShipmentWithCarrier,
  confirmPickup,
  fetchPickupManifest,
  fetchPickups,
  fetchShipment,
  fetchShipmentLabelLink,
  fetchShipmentList,
  markShipmentVoided,
  type PickupChangeView,
  type PickupListFilter,
  type PickupManifestView,
  type PickupPageView,
  type PickupView,
  QueryKeys,
  removePickupShipment,
  requestPickup,
  setShipmentStatus,
  type ShipmentCheckResultView,
  type ShipmentDetailView,
  type ShipmentLabelLinkView,
  type ShipmentListFilter,
  type ShipmentRowPageView,
  type ShipmentRowView
} from '@platform/api-client'

import { apiClient } from '../api'

// The connections of the store with what each can do: the same cache entry as Settings → Carriers and the orders page
export function useConnectionViews(
  storeId: string,
  enabled: boolean
): readonly CarrierConnectionView[] {
  const query = useQuery({
    queryKey: QueryKeys.carriers.list(storeId),
    queryFn: ({ signal }) => fetchAllCarrierConnections(apiClient, storeId, signal),
    enabled
  })
  return query.data ?? NO_CONNECTIONS
}

const NO_CONNECTIONS: readonly CarrierConnectionView[] = []

// The guides of the store a page at a time (a cursor), for the filters of the screen. The rows of the earlier filters stay on
// the screen until the answer for the new ones arrives.
export function useShipmentList(
  storeId: string,
  filter: ShipmentListFilter,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<ShipmentRowPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.shipments.list(storeId, filter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchShipmentList(apiClient, storeId, { ...filter, cursor: pageParam }, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    placeholderData: keepPreviousData,
    enabled
  })
}

export function useShipmentDetail(
  storeId: string,
  shipmentId: string | null
): UseQueryResult<ShipmentDetailView> {
  return useQuery({
    queryKey: QueryKeys.shipments.detail(storeId, shipmentId ?? ''),
    queryFn: ({ signal }) => fetchShipment(apiClient, storeId, shipmentId ?? '', signal),
    enabled: shipmentId !== null
  })
}

// Every change of a guide moves what the orders page draws too, so the whole family of the store is read again
function useShipmentMutation<Input, Output>(
  storeId: string,
  run: (input: Input) => Promise<Output>
): UseMutationResult<Output, Error, Input> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.shipments.all(storeId) })
      void queryClient.invalidateQueries({ queryKey: QueryKeys.pickups.all(storeId) })
    }
  })
}

export function useCancelShipment(
  storeId: string
): UseMutationResult<ShipmentRowView, Error, string> {
  return useShipmentMutation(storeId, id => cancelShipment(apiClient, storeId, id))
}

export function useMarkShipmentVoided(
  storeId: string
): UseMutationResult<ShipmentRowView, Error, string> {
  return useShipmentMutation(storeId, id => markShipmentVoided(apiClient, storeId, id))
}

export function useCheckShipment(
  storeId: string
): UseMutationResult<ShipmentCheckResultView, Error, string> {
  return useShipmentMutation(storeId, id => checkShipmentWithCarrier(apiClient, storeId, id))
}

export function useSetShipmentStatus(
  storeId: string
): UseMutationResult<
  ShipmentRowView,
  Error,
  { id: string; status: string; guideNumber?: string; description?: string }
> {
  return useShipmentMutation(storeId, ({ id, ...input }) =>
    setShipmentStatus(apiClient, storeId, id, input)
  )
}

// The link of a label is good for minutes: it is asked for at the press and never cached
export function useShipmentLabel(
  storeId: string
): UseMutationResult<ShipmentLabelLinkView, Error, string> {
  return useMutation({ mutationFn: id => fetchShipmentLabelLink(apiClient, storeId, id) })
}

export function usePickupList(
  storeId: string,
  filter: PickupListFilter,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<PickupPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.pickups.list(storeId, filter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchPickups(apiClient, storeId, { ...filter, cursor: pageParam }, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    placeholderData: keepPreviousData,
    enabled
  })
}

// The manifest names customers: it is read while its panel is open and not kept longer than that
export function usePickupManifest(
  storeId: string,
  pickupId: string | null
): UseQueryResult<PickupManifestView> {
  return useQuery({
    queryKey: QueryKeys.pickups.manifest(storeId, pickupId ?? ''),
    queryFn: ({ signal }) => fetchPickupManifest(apiClient, storeId, pickupId ?? '', signal),
    enabled: pickupId !== null,
    gcTime: 0
  })
}

function usePickupMutation<Input, Output>(
  storeId: string,
  run: (input: Input) => Promise<Output>
): UseMutationResult<Output, Error, Input> {
  // A pickup change moves the guides it holds, so both families are read again
  return useShipmentMutation(storeId, run)
}

export function useRequestPickup(
  storeId: string
): UseMutationResult<
  Awaited<ReturnType<typeof requestPickup>>,
  Error,
  { connectionId: string; shipmentIds?: readonly string[]; confirmAfterCutoff?: boolean }
> {
  return usePickupMutation(storeId, input => requestPickup(apiClient, storeId, input))
}

export function useAddPickupShipments(
  storeId: string
): UseMutationResult<
  PickupChangeView,
  Error,
  { pickupId: string; shipmentIds: readonly string[]; confirmAfterCutoff?: boolean }
> {
  return usePickupMutation(storeId, ({ pickupId, ...input }) =>
    addPickupShipments(apiClient, storeId, pickupId, input)
  )
}

export function useRemovePickupShipment(
  storeId: string
): UseMutationResult<PickupView, Error, { pickupId: string; shipmentId: string }> {
  return usePickupMutation(storeId, ({ pickupId, shipmentId }) =>
    removePickupShipment(apiClient, storeId, pickupId, shipmentId)
  )
}

export function useConfirmPickup(storeId: string): UseMutationResult<PickupView, Error, string> {
  return usePickupMutation(storeId, id => confirmPickup(apiClient, storeId, id))
}

export function useCancelPickup(storeId: string): UseMutationResult<PickupView, Error, string> {
  return usePickupMutation(storeId, id => cancelPickup(apiClient, storeId, id))
}
