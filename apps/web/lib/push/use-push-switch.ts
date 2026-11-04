'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { StorageKeys } from '@platform/api-client'

import { apiClient } from '../api'
import { webEnv } from '../env'

import {
  hasPushSubscription,
  PushSubscribeResult,
  type PushSubscribeResultType,
  isPushConfigured,
  pushPermission,
  subscribeToPush,
  unsubscribeFromPush
} from './push-browser'

function setTurnedOff(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(StorageKeys.PUSH_TURNED_OFF, '1')
    else window.localStorage.removeItem(StorageKeys.PUSH_TURNED_OFF)
  } catch {
    // Without storage the silent re-subscribe may come back: harmless
  }
}

export const PushSwitchState = {
  // Not read yet (the server render, or the first effect)
  UNKNOWN: 'unknown',
  // The environment has no server key: nothing to do with the browser
  NOT_CONFIGURED: 'not_configured',
  UNSUPPORTED: 'unsupported',
  // The browser blocked notifications: only its site settings can undo it
  BLOCKED: 'blocked',
  OFF: 'off',
  ON: 'on'
} as const
export type PushSwitchStateType = (typeof PushSwitchState)[keyof typeof PushSwitchState]

// The switch for push on this device (TDD_06 §7.3): on when the browser allows it and holds a subscription
export function usePushSwitch(storeId: string): {
  state: PushSwitchStateType
  isBusy: boolean
  turnOn: () => Promise<PushSubscribeResultType>
  turnOff: () => Promise<void>
} {
  const [state, setState] = useState<PushSwitchStateType>(PushSwitchState.UNKNOWN)
  const [isBusy, setIsBusy] = useState(false)

  // Only the newest read may write: an older one that resolves late must not undo a newer answer
  const latestRead = useRef(0)
  useEffect(
    () => () => {
      latestRead.current = -1
    },
    []
  )

  const read = useCallback(async (): Promise<void> => {
    latestRead.current += 1
    const mine = latestRead.current
    if (!isPushConfigured(webEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY))
      return setState(PushSwitchState.NOT_CONFIGURED)
    const permission = pushPermission(webEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
    if (permission === null) return setState(PushSwitchState.UNSUPPORTED)
    if (permission === 'denied') return setState(PushSwitchState.BLOCKED)
    if (permission === 'default') return setState(PushSwitchState.OFF)
    const hasOne = await hasPushSubscription()
    if (latestRead.current === mine) {
      setState(hasOne ? PushSwitchState.ON : PushSwitchState.OFF)
    }
  }, [])

  useEffect(() => {
    void read()
  }, [read])

  const turnOn = useCallback(async (): Promise<PushSubscribeResultType> => {
    setIsBusy(true)
    try {
      setTurnedOff(false)
      const result = await subscribeToPush(apiClient, storeId, webEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
      if (result === PushSubscribeResult.UNSUPPORTED) setState(PushSwitchState.UNSUPPORTED)
      else await read()
      return result
    } finally {
      setIsBusy(false)
    }
  }, [read, storeId])

  const turnOff = useCallback(async (): Promise<void> => {
    setIsBusy(true)
    try {
      setTurnedOff(true)
      await unsubscribeFromPush(apiClient, storeId)
      await read()
    } finally {
      setIsBusy(false)
    }
  }, [read, storeId])

  return { state, isBusy, turnOn, turnOff }
}
