'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useEffect } from 'react'

import { StorageKeys } from '@platform/api-client'

import { apiClient } from '../api'
import { webEnv } from '../env'
import { toast } from '../toast'
import { useErrorText } from '../use-error-text'

import { PushSubscribeResult, pushPermission, subscribeToPush } from './push-browser'
import { PushOffer, pushOfferFor, shouldSyncOnLoad } from './push-offer'

function readOffered(): boolean {
  try {
    return window.localStorage.getItem(StorageKeys.PUSH_OFFERED) !== null
  } catch {
    return false
  }
}

function readTurnedOff(): boolean {
  try {
    return window.localStorage.getItem(StorageKeys.PUSH_TURNED_OFF) !== null
  } catch {
    return false
  }
}

function writeOffered(): void {
  try {
    window.localStorage.setItem(StorageKeys.PUSH_OFFERED, '1')
  } catch {
    // Without storage the question may come again next time: harmless
  }
}

const PROMPT_TOAST_ID = 'push-prompt'

// The silent registration of a browser that already allows push runs once per page load
let syncedInThisPage = false

// Opening a store: a browser that allows push tells the server it is there (see `shouldSyncOnLoad`)
export function usePushSync(storeId: string): void {
  useEffect(() => {
    const permission = pushPermission(webEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
    if (
      !shouldSyncOnLoad({ permission, turnedOff: readTurnedOff(), alreadySynced: syncedInThisPage })
    ) {
      return
    }
    syncedInThisPage = true
    // Marked before the call so two stores opening at once register once; given back if it failed (offline,
    // a busy api), so that the next store that opens tries again
    subscribeToPush(apiClient, storeId, webEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
      .then(result => {
        if (result !== PushSubscribeResult.SUBSCRIBED) syncedInThisPage = false
      })
      .catch(() => {
        syncedInThisPage = false
      })
  }, [storeId])
}

// The question about notifications on this device, asked after the agent resolves a conversation
export function usePushOffer(storeId: string): { offer: () => void } {
  const t = useTranslations('notifications.push')
  const errorText = useErrorText()
  const tAll = useTranslations()

  const enable = useCallback(async (): Promise<void> => {
    try {
      const result = await subscribeToPush(apiClient, storeId, webEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
      if (result === PushSubscribeResult.SUBSCRIBED) toast.success(t('enabled'))
      else if (result === PushSubscribeResult.DENIED) toast.error(t('denied'))
    } catch (error) {
      toast.error(errorText(error))
    }
  }, [storeId, t, tAll])

  const offer = useCallback((): void => {
    const decision = pushOfferFor({
      permission: pushPermission(webEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY),
      alreadyOffered: readOffered()
    })
    if (decision === PushOffer.NONE) return
    if (decision === PushOffer.SYNC) {
      // The person switched push off on the preferences page: their choice outlives the permission
      if (readTurnedOff()) return
      // Silent: the permission is already given
      if (syncedInThisPage) return
      syncedInThisPage = true
      void subscribeToPush(apiClient, storeId, webEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY).catch(
        () => undefined
      )
      return
    }
    // Marked when the person answers or dismisses it, not when it shows: a reload or a toast that
    // Sonner drops must not use up the only question
    toast(t('prompt'), {
      id: PROMPT_TOAST_ID,
      duration: Infinity,
      action: {
        label: t('enable'),
        onClick: () => {
          writeOffered()
          void enable()
        }
      },
      cancel: { label: t('later'), onClick: writeOffered },
      onDismiss: writeOffered
    })
  }, [enable, storeId, t])

  return { offer }
}
