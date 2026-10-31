'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import {
  type BulkOperation,
  type BulkResultView,
  type BulkTarget,
  bulkConversations,
  QueryKeys
} from '@platform/api-client'

import { useStore } from '../../components/providers/store-context'
import { apiClient } from '../api'
import { errorCodeOf, knownErrorCode } from '../error-message'

import { BulkOutcomes, type PreviousState, singleResultKey, summaryOf, undoStepsOf } from './bulk'

// Actions in flight in the whole page: the bar, the list and the open conversation each have a runner,
// and two actions started from the keyboard at once would overlap
let inFlightCount = 0

export interface BulkRunner {
  isPending: boolean
  // Any runner of the page has an action going
  isBusy: () => boolean
  // True when a new action may start. When one is going it says so with a toast and gives false, so
  // that a key pressed meanwhile is never taken without a word
  claim: () => boolean
  // Runs the action and tells the agent what happened; resolves to the result, or null when the
  // request itself failed
  run: (
    operation: BulkOperation,
    target: BulkTarget,
    previous: readonly PreviousState[],
    // The customer, when the action is for one conversation: the toast then says who it changed
    subject?: string
  ) => Promise<BulkResultView | null>
}

// Runs a bulk action and says what became of it: one toast with the number changed, the reason of each
// kind of failure, and an Undo for what can be taken back. The events of the api make the list stale
// as well; reading it again here covers a socket that is down.
export function useBulkRunner(): BulkRunner {
  const t = useTranslations('inbox.bulk.result')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState(0)

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: QueryKeys.conversations.all(storeId) }),
    [queryClient, storeId]
  )

  const reasonsOf = useCallback(
    (summary: ReturnType<typeof summaryOf>): string =>
      summary.reasons
        .map(({ code, count }) =>
          t('reason', { reason: tAll(`errors.${knownErrorCode(code)}`), count })
        )
        .join('; '),
    [t, tAll]
  )

  const undo = useCallback(
    async (steps: ReturnType<typeof undoStepsOf>): Promise<void> => {
      try {
        const results = await Promise.allSettled(
          steps.map(step =>
            bulkConversations(apiClient, storeId, step.operation, {
              conversationIds: step.conversationIds
            })
          )
        )
        // A step that failed as a whole leaves all of its conversations as they are
        const failed = results.reduce(
          (sum, result, index) =>
            sum +
            (result.status === 'fulfilled'
              ? result.value.failed.length
              : (steps[index]?.conversationIds.length ?? 0)),
          0
        )
        if (failed === 0) toast.success(t('undone'))
        else toast.warning(t('undonePartly', { count: failed }))
      } finally {
        await refresh()
      }
    },
    [storeId, t, tAll, refresh]
  )

  const run = useCallback<BulkRunner['run']>(
    async (operation, target, previous, subject) => {
      setPending(count => count + 1)
      inFlightCount += 1
      let result: BulkResultView
      try {
        result = await bulkConversations(apiClient, storeId, operation, target)
      } catch (error) {
        toast.error(tAll(`errors.${errorCodeOf(error)}`))
        return null
      } finally {
        setPending(count => count - 1)
        inFlightCount -= 1
        void refresh()
      }

      const summary = summaryOf(result)
      // The old state is known only for rows the agent ticked: a filter reaches what the list never loaded
      const steps =
        'conversationIds' in target ? undoStepsOf(operation, previous, result.succeeded) : []
      const action =
        steps.length === 0 ? undefined : { label: t('undo'), onClick: () => void undo(steps) }
      const truncated = summary.truncated ? ` ${t('truncated')}` : ''

      const isOne = 'conversationIds' in target && target.conversationIds.length === 1
      if (summary.outcome === BulkOutcomes.ALL_DONE) {
        const text =
          isOne && subject !== undefined
            ? t(`one.${singleResultKey(operation)}`, { name: subject })
            : t('allDone', { count: summary.succeeded })
        toast.success(`${text}${truncated}`, { action })
      } else if (summary.outcome === BulkOutcomes.SOME_DONE) {
        toast.warning(
          `${t('someDone', { succeeded: summary.succeeded, failed: summary.failed, reasons: reasonsOf(summary) })}${truncated}`,
          { action }
        )
      } else {
        toast.error(`${t('noneDone', { reasons: reasonsOf(summary) })}${truncated}`)
      }
      return result
    },
    [storeId, t, tAll, refresh, undo, reasonsOf]
  )

  const claim = useCallback((): boolean => {
    if (inFlightCount === 0) return true
    toast.info(t('busy'))
    return false
  }, [t])

  return { isPending: pending > 0, isBusy: () => inFlightCount > 0, claim, run }
}
