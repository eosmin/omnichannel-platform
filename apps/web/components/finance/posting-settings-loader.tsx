'use client'

import type { ReactElement } from 'react'

import type { FinanceSettingsView } from '@platform/api-client'

import { useFinanceAccounts } from '../../lib/finance/use-finance'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'

import { PostingSettingsPanel } from './posting-settings-panel'

// The posting settings need the chart for the rounding account: they read it themselves, beside the other panels
export function PostingSettingsLoader({
  settings
}: {
  settings: FinanceSettingsView
}): ReactElement {
  const { storeId } = useStore()
  const accounts = useFinanceAccounts(storeId, true)
  if (accounts.isError) {
    return <LoadFailed error={accounts.error} onRetry={() => void accounts.refetch()} />
  }
  if (accounts.data === undefined) return <PageLoading />
  return <PostingSettingsPanel settings={settings} accounts={accounts.data} />
}
