'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import { type CarrierConnectionView } from '@platform/api-client'
import { CarrierConnectionLimits, CarrierConnectionStatus } from '@platform/core/domain'

import {
  carrierRulesChanges,
  carrierRulesDraftOf,
  type CarrierRulesDraft,
  carrierRulesProblems,
  hasInternalGuide,
  PICKUP_WEEKDAYS
} from '../../lib/settings/carriers-form'
import { useUpdateCarrier } from '../../lib/settings/use-carriers'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

// Edit a connection: its name, whether it is the default, the pickup rules (days, cutoff, automatic request, reminder),
// and new credentials for a carrier with an account. A connection that was let go takes only a new name, to free the
// old one (the api refuses the rest). Only what changed is sent.
export function CarrierRulesDialog({
  connection,
  onClose
}: {
  connection: CarrierConnectionView
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.carriers.rules')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const update = useUpdateCarrier(storeId, connection.id)
  const guard = useSubmitGuard()
  const id = useId()
  const [openedAs] = useState(connection.displayName)
  const [draft, setDraft] = useState<CarrierRulesDraft>(() => carrierRulesDraftOf(connection))
  const [showProblems, setShowProblems] = useState(false)
  const disconnected = connection.status === String(CarrierConnectionStatus.DISABLED)
  const problems = carrierRulesProblems(draft)
  const changes = carrierRulesChanges(connection, draft)
  const changed = Object.keys(changes).length > 0
  const pending = update.isPending
  const set = (patch: Partial<CarrierRulesDraft>): void =>
    setDraft(current => ({ ...current, ...patch }))
  const has = (problem: (typeof problems)[number]): boolean =>
    showProblems && problems.includes(problem)

  const toggleDay = (day: number): void =>
    set({
      pickupDays: draft.pickupDays.includes(day)
        ? draft.pickupDays.filter(item => item !== day)
        : [...draft.pickupDays, day].sort((a, b) => a - b)
    })

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (pending || !changed || !guard.enter()) return
    if (problems.length > 0) {
      setShowProblems(true)
      guard.leave()
      return
    }
    update.mutate(changes, {
      onSuccess: saved => {
        toast.success(t('saved', { name: saved.displayName }))
        onClose()
      },
      onSettled: guard.leave
    })
  }

  return (
    <Dialog open onOpenChange={open => (open || pending ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title', { name: openedAs })}</DialogTitle>
          <DialogDescription>
            {disconnected ? t('descriptionDisconnected') : t('description')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-name`}>{t('name')}</Label>
            <Input
              id={`${id}-name`}
              value={draft.displayName}
              onChange={event => set({ displayName: event.target.value })}
              maxLength={CarrierConnectionLimits.DISPLAY_NAME_MAX_LENGTH}
              autoComplete="off"
              disabled={pending}
              aria-invalid={has('name')}
            />
          </div>
          {disconnected ? null : (
            <>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.isDefault}
                  onChange={event => set({ isDefault: event.target.checked })}
                  disabled={pending || connection.isDefault}
                  className="mt-1"
                />
                <span>
                  {t('isDefault')}
                  <span className="text-muted-foreground block text-xs">{t('isDefaultHint')}</span>
                </span>
              </label>
              <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
                <legend className="px-1 text-sm font-medium">{t('pickup.legend')}</legend>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.pickupEnabled}
                    onChange={event => set({ pickupEnabled: event.target.checked })}
                    disabled={pending}
                    className="mt-1"
                  />
                  <span>
                    {t('pickup.enabled')}
                    <span className="text-muted-foreground block text-xs">
                      {t('pickup.enabledHint')}
                    </span>
                  </span>
                </label>
                {draft.pickupEnabled ? (
                  <>
                    <div
                      role="group"
                      aria-label={t('pickup.days')}
                      className="flex flex-wrap gap-2"
                    >
                      {PICKUP_WEEKDAYS.map(day => (
                        <label
                          key={day}
                          className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={draft.pickupDays.includes(day)}
                            onChange={() => toggleDay(day)}
                            disabled={pending}
                          />
                          {t(`pickup.weekdays.${day}`)}
                        </label>
                      ))}
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`${id}-cutoff`}>{t('pickup.cutoff')}</Label>
                      <Input
                        id={`${id}-cutoff`}
                        value={draft.pickupCutoffTime}
                        onChange={event => set({ pickupCutoffTime: event.target.value })}
                        placeholder={t('pickup.timePlaceholder')}
                        disabled={pending}
                        className="max-w-32"
                        aria-invalid={has('cutoff')}
                      />
                      <p className="text-muted-foreground text-xs">{t('pickup.cutoffHint')}</p>
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`${id}-reminder`}>{t('pickup.reminder')}</Label>
                      <Input
                        id={`${id}-reminder`}
                        inputMode="numeric"
                        value={draft.pickupReminderMinutes}
                        onChange={event => set({ pickupReminderMinutes: event.target.value })}
                        disabled={pending}
                        className="max-w-32"
                        aria-invalid={has('reminder')}
                      />
                      <p className="text-muted-foreground text-xs">{t('pickup.reminderHint')}</p>
                    </div>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.autoPickup}
                        onChange={event => set({ autoPickup: event.target.checked })}
                        disabled={pending}
                        className="mt-1"
                      />
                      <span>
                        {t('pickup.auto')}
                        <span className="text-muted-foreground block text-xs">
                          {t('pickup.autoHint')}
                        </span>
                      </span>
                    </label>
                    {draft.autoPickup ? (
                      <div className="grid gap-1.5">
                        <Label htmlFor={`${id}-auto`}>{t('pickup.autoTime')}</Label>
                        <Input
                          id={`${id}-auto`}
                          value={draft.autoPickupTime}
                          onChange={event => set({ autoPickupTime: event.target.value })}
                          placeholder={t('pickup.timePlaceholder')}
                          disabled={pending}
                          className="max-w-32"
                          aria-invalid={has('autoTime')}
                        />
                      </div>
                    ) : null}
                  </>
                ) : null}
              </fieldset>
              {connection.hasCredentials && !hasInternalGuide(connection.capabilities) ? (
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-credentials`}>{t('credentials')}</Label>
                  <Textarea
                    id={`${id}-credentials`}
                    value={draft.credentials}
                    onChange={event => set({ credentials: event.target.value })}
                    placeholder={t('credentialsPlaceholder')}
                    spellCheck={false}
                    autoComplete="off"
                    className="font-mono"
                    disabled={pending}
                    aria-invalid={has('credentials')}
                  />
                  <p className="text-muted-foreground text-xs">{t('credentialsHint')}</p>
                </div>
              ) : null}
            </>
          )}
          {showProblems && problems.length > 0 ? (
            <ul role="alert" className="text-destructive list-disc pl-5 text-sm">
              {problems.map(problem => (
                <li key={problem}>{t(`problems.${problem}`)}</li>
              ))}
            </ul>
          ) : null}
          <MutationError error={update.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              {tAll('common.cancel')}
            </Button>
            <Button type="submit" disabled={pending || !changed} busy={pending}>
              {pending ? t('saving') : t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
