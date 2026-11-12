'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  type BulkLabelJobView,
  confirmOrdersBulk,
  fetchBulkLabelJob,
  mergeLabels,
  QueryKeys,
  requestPickup,
  sendOrderMessage,
  startBulkLabels
} from '@platform/api-client'
import { BulkLabelJobStatus, OrderMessageKind } from '@platform/core/domain'

import { apiClient } from '../api'
import { errorCodeOf } from '../error-message'

import {
  BulkActionKinds,
  type BulkActionKind,
  type BulkInput,
  type BulkReport,
  confirmReport,
  jobProgress,
  labelsReport,
  pendingConfirmationIds,
  type PickupAttempt,
  pickupReport,
  pickupTargets,
  printReport,
  printTargets,
  summaryReport,
  type SummaryAttempt
} from './order-bulk'

const POLL_MS = 2000
// A run that is neither done nor failed after this long is shown as it stands: the report says what the server last said
const POLL_LIMIT_MS = 10 * 60 * 1000
const SUMMARY_CONCURRENCY = 3
// A poll that fails is asked again a few times: the run goes on in the worker whatever the network does
const POLL_RETRIES = 3

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const RUNNING: ReadonlySet<string> = new Set([
  BulkLabelJobStatus.QUEUED,
  BulkLabelJobStatus.RUNNING
])

export interface OrderBulk {
  // The action going now, and how far a run of labels is (0 to 1; null when it has no figure yet)
  busy: BulkActionKind | null
  progress: number | null
  // What the last action did; null once it is dismissed
  report: BulkReport | null
  // The request itself failed (nothing is known of the orders): the code to draw
  failure: string | null
  dismiss: () => void
  confirm: (via: string) => Promise<void>
  summary: () => Promise<void>
  labels: (connectionId?: string) => Promise<void>
  print: () => Promise<void>
  pickup: () => Promise<void>
}

// Runs the five actions over the ticked rows and turns what each answers into a report. One action at a time: the others
// wait for it. After each one the orders and their guides are read again, so the final state shown is the server's.
export function useOrderBulk(storeId: string, input: BulkInput): OrderBulk {
  const client = useQueryClient()
  const [busy, setBusy] = useState<BulkActionKind | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [report, setReport] = useState<BulkReport | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const latest = useRef(input)
  latest.current = input
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const execute = useCallback(
    async (kind: BulkActionKind, work: () => Promise<BulkReport>): Promise<void> => {
      if (running.current) return
      running.current = true
      setBusy(kind)
      setProgress(null)
      setFailure(null)
      setReport(null)
      try {
        const done = await work()
        if (mounted.current) setReport(done)
      } catch (error) {
        if (mounted.current) setFailure(errorCodeOf(error))
      } finally {
        running.current = false
        if (mounted.current) {
          setBusy(null)
          setProgress(null)
        }
        // The state the report shows is read again, whatever happened to the request
        await Promise.all([
          client.invalidateQueries({ queryKey: QueryKeys.orders.all(storeId) }),
          client.invalidateQueries({ queryKey: QueryKeys.shipments.all(storeId) })
        ])
      }
    },
    [client, storeId]
  )

  const confirm = useCallback(
    (via: string) =>
      execute(BulkActionKinds.CONFIRM, async () => {
        const { selectedIds } = latest.current
        const pending = pendingConfirmationIds(latest.current)
        const notSent = selectedIds.filter(id => !pending.includes(id))
        const result = await confirmOrdersBulk(apiClient, storeId, pending, via)
        return confirmReport(selectedIds, notSent, result)
      }),
    [execute, storeId]
  )

  const summary = useCallback(
    () =>
      execute(BulkActionKinds.SUMMARY, async () => {
        const ids = [...latest.current.selectedIds]
        // One key for the press: asking again after a lost answer never sends the summary twice
        const idempotencyKey = crypto.randomUUID()
        const attempts: SummaryAttempt[] = []
        let next = 0
        let settled = 0
        const worker = async (): Promise<void> => {
          while (next < ids.length) {
            const orderId = ids[next++] as string
            try {
              const outcome = await sendOrderMessage(apiClient, storeId, orderId, {
                kind: OrderMessageKind.ORDER_SUMMARY,
                idempotencyKey
              })
              attempts[ids.indexOf(orderId)] = { orderId, outcome }
            } catch (error) {
              attempts[ids.indexOf(orderId)] = { orderId, code: errorCodeOf(error) }
            }
            settled += 1
            if (mounted.current) setProgress(settled / ids.length)
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(SUMMARY_CONCURRENCY, ids.length) }, () => worker())
        )
        return summaryReport(attempts)
      }),
    [execute, storeId]
  )

  const readJob = useCallback(
    async (job: BulkLabelJobView): Promise<BulkLabelJobView> => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await fetchBulkLabelJob(apiClient, storeId, job.id)
        } catch (error) {
          if (attempt >= POLL_RETRIES) throw error
          await wait(POLL_MS)
        }
      }
    },
    [storeId]
  )

  const labels = useCallback(
    (connectionId?: string) =>
      execute(BulkActionKinds.LABELS, async () => {
        const ids = [...latest.current.selectedIds]
        let job: BulkLabelJobView = await startBulkLabels(apiClient, storeId, {
          orderIds: ids,
          ...(connectionId === undefined ? {} : { connectionId })
        })
        const startedAt = Date.now()
        while (RUNNING.has(job.status) && Date.now() - startedAt < POLL_LIMIT_MS) {
          if (mounted.current) setProgress(jobProgress(job))
          await wait(POLL_MS)
          job = await readJob(job)
        }
        return labelsReport(job, ids)
      }),
    [execute, readJob, storeId]
  )

  const print = useCallback(
    () =>
      execute(BulkActionKinds.PRINT, async () => {
        const targets = printTargets(latest.current)
        const merge = await mergeLabels(
          apiClient,
          storeId,
          targets.map(target => target.id)
        )
        return printReport(latest.current.selectedIds, targets, merge)
      }),
    [execute, storeId]
  )

  const pickup = useCallback(
    () =>
      execute(BulkActionKinds.PICKUP, async () => {
        const targets = pickupTargets(latest.current)
        const byConnection = new Map<string, string[]>()
        for (const target of targets) {
          byConnection.set(target.connectionId, [
            ...(byConnection.get(target.connectionId) ?? []),
            target.id
          ])
        }
        const attempts: PickupAttempt[] = []
        for (const [connectionId, shipmentIds] of byConnection) {
          try {
            const result = await requestPickup(apiClient, storeId, { connectionId, shipmentIds })
            attempts.push({ connectionId, shipmentIds, result })
          } catch (error) {
            attempts.push({ connectionId, shipmentIds, result: { code: errorCodeOf(error) } })
          }
        }
        return pickupReport(latest.current.selectedIds, targets, attempts)
      }),
    [execute, storeId]
  )

  const dismiss = useCallback(() => {
    setReport(null)
    setFailure(null)
  }, [])

  return useMemo(
    () => ({ busy, progress, report, failure, dismiss, confirm, summary, labels, print, pickup }),
    [busy, progress, report, failure, dismiss, confirm, summary, labels, print, pickup]
  )
}
