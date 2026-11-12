'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useId, useState } from 'react'

import { ApiError, type CarrierConnectionView } from '@platform/api-client'
import { CarrierCapability } from '@platform/core/domain'
import { ClientErrorCodes } from '@platform/core/errors'

import { useRequestPickup } from '../../lib/shipping/use-shipping-screens'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { SELECT_CLASS } from '../ui/field-classes'
import { Label } from '../ui/label'

// A connection a pickup is asked of from here: its carrier takes requests and makes its own guides (a pickup-bound carrier
// gets its pickup with the guides). By capability, never by the carrier's name.
export function connectionsThatTakeRequests(
  connections: readonly CarrierConnectionView[]
): readonly CarrierConnectionView[] {
  return connections.filter(
    connection =>
      connection.pickupEnabled &&
      connection.capabilities.includes(CarrierCapability.PICKUP_REQUEST) &&
      !connection.capabilities.includes(CarrierCapability.PICKUP_BOUND_GUIDES)
  )
}

// "Request now": asks the carrier for every guide of the connection that is waiting
export function PickupRequestDialog({
  connections,
  onClose
}: {
  connections: readonly CarrierConnectionView[]
  onClose: () => void
}): ReactElement {
  const t = useTranslations('pickups.request')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const request = useRequestPickup(storeId)
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? '')
  const [refusal, setRefusal] = useState<string | null>(null)
  const [needsCutoffOk, setNeedsCutoffOk] = useState(false)
  const id = useId()
  const send = (): void => {
    setRefusal(null)
    request.mutate(
      { connectionId, ...(needsCutoffOk ? { confirmAfterCutoff: true } : {}) },
      {
        onSuccess: answer => {
          toast.success(t(answer.waiting.length > 0 ? 'doneSomeWait' : 'done'))
          onClose()
        },
        onError: error => {
          if (error instanceof ApiError && error.is(ClientErrorCodes.PICKUP_CUTOFF_PASSED)) {
            setNeedsCutoffOk(true)
            return
          }
          setRefusal(errorText(error))
        }
      }
    )
  }
  return (
    <Dialog
      open
      onOpenChange={next =>
        next || !request.isPending ? (next ? undefined : onClose()) : undefined
      }
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-carrier`}>{t('carrier')}</Label>
          <select
            id={`${id}-carrier`}
            className={SELECT_CLASS}
            value={connectionId}
            onChange={event => {
              setConnectionId(event.target.value)
              setNeedsCutoffOk(false)
            }}
          >
            {connections.map(connection => (
              <option key={connection.id} value={connection.id}>
                {connection.displayName}
              </option>
            ))}
          </select>
        </div>
        {needsCutoffOk ? (
          <p role="alert" className="text-sm font-medium text-amber-700 dark:text-amber-300">
            {t('cutoffPassed')}
          </p>
        ) : null}
        {refusal === null ? null : (
          <p role="alert" className="text-destructive text-sm">
            {refusal}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={request.isPending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            disabled={connectionId === '' || request.isPending}
            busy={request.isPending}
            onClick={send}
          >
            {needsCutoffOk ? t('sendAnyway') : t('send')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
