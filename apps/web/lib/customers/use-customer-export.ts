'use client'

import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'

import { type ExportView, QueryKeys, requestCustomersExport } from '@platform/api-client'

import { apiClient } from '../api'

// "Export CSV" of the customers page: queues the file for the search the page shows
export function useExportCustomers(storeId: string): UseMutationResult<ExportView, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (q: string) => requestCustomersExport(apiClient, storeId, q),
    // The exports center shows the new row the moment the person gets there
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.exports.all(storeId) })
    }
  })
}
