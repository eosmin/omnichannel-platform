'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import type { CarrierConnectFieldView, CarrierConnectionView } from '@platform/api-client'
import {
  CarrierConnectionLimits,
  CarrierConnectionStatus,
  LabelFormat,
  LocalGuide,
  ShippingPayer
} from '@platform/core/domain'

import {
  carrierRulesChanges,
  carrierRulesDraftOf,
  type CarrierRulesDraft,
  acceptsCashOnDelivery,
  canPoll,
  carrierRulesProblems,
  credentialShapeOf,
  hasInternalGuide,
  PICKUP_WEEKDAYS
} from '../../lib/settings/carriers-form'
import { missingFields } from '../../lib/settings/connect-form'
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

import { CarrierFieldInputs } from './carrier-field-inputs'

// Edit a connection: its name, whether it is the default, the pickup rules (days, cutoff, automatic request, reminder),
// and new credentials for a carrier with an account. A connection that was let go takes only a new name, to free the
// old one (the api refuses the rest). Only what changed is sent.
export function CarrierRulesDialog({
  connection,
  connectFields,
  onClose
}: {
  connection: CarrierConnectionView
  // What the registry says its carrier asks for; none (or not loaded yet): the free JSON box
  connectFields: readonly CarrierConnectFieldView[]
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.carriers.rules')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const update = useUpdateCarrier(storeId, connection.id)
  const guard = useSubmitGuard()
  const id = useId()
  const [openedAs] = useState(connection.displayName)
  const shape = credentialShapeOf(connection, connectFields)
  const [draft, setDraft] = useState<CarrierRulesDraft>(() =>
    carrierRulesDraftOf(connection, shape.fields)
  )
  const [showProblems, setShowProblems] = useState(false)
  const disconnected = connection.status === String(CarrierConnectionStatus.DISABLED)
  const problems = carrierRulesProblems(draft, shape)
  const changes = carrierRulesChanges(connection, draft, shape)
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
              <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
                <legend className="px-1 text-sm font-medium">{t('shipping.legend')}</legend>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-payer`}>{t('shipping.payer')}</Label>
                  <select
                    id={`${id}-payer`}
                    value={draft.defaultShippingPayer}
                    onChange={event => set({ defaultShippingPayer: event.target.value })}
                    disabled={pending}
                    className="border-input bg-background h-9 max-w-xs rounded-md border px-2 text-sm"
                  >
                    {Object.values(ShippingPayer).map(payer => (
                      <option key={payer} value={payer}>
                        {t(`shipping.payers.${payer}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-format`}>{t('shipping.labelFormat')}</Label>
                  <select
                    id={`${id}-format`}
                    value={draft.labelFormat}
                    onChange={event => set({ labelFormat: event.target.value })}
                    disabled={pending}
                    className="border-input bg-background h-9 max-w-xs rounded-md border px-2 text-sm"
                  >
                    {Object.values(LabelFormat).map(format => (
                      <option key={format} value={format}>
                        {t(`shipping.labelFormats.${format}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      ['defaultFee', 'fees.default'],
                      ['minFee', 'fees.min'],
                      ['maxFee', 'fees.max']
                    ] as const
                  ).map(([field, label]) => (
                    <div key={field} className="grid gap-1.5">
                      <Label htmlFor={`${id}-${field}`}>{t(`shipping.${label}`)}</Label>
                      <Input
                        id={`${id}-${field}`}
                        inputMode="decimal"
                        value={draft[field]}
                        onChange={event => set({ [field]: event.target.value })}
                        disabled={pending}
                        aria-invalid={has('fee') || has('feeRange')}
                      />
                    </div>
                  ))}
                </div>
                <p className="text-muted-foreground text-xs">{t('shipping.feesHint')}</p>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-attempts`}>{t('shipping.attempts')}</Label>
                  <Input
                    id={`${id}-attempts`}
                    inputMode="numeric"
                    value={draft.maxDeliveryAttempts}
                    onChange={event => set({ maxDeliveryAttempts: event.target.value })}
                    disabled={pending}
                    className="max-w-32"
                    aria-invalid={has('attempts')}
                  />
                  <p className="text-muted-foreground text-xs">{t('shipping.attemptsHint')}</p>
                </div>
                {canPoll(connection.capabilities) ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor={`${id}-poll`}>{t('shipping.poll')}</Label>
                    <Input
                      id={`${id}-poll`}
                      inputMode="numeric"
                      value={draft.pollIntervalMinutes}
                      onChange={event => set({ pollIntervalMinutes: event.target.value })}
                      disabled={pending}
                      className="max-w-32"
                      aria-invalid={has('poll')}
                    />
                    <p className="text-muted-foreground text-xs">{t('shipping.pollHint')}</p>
                  </div>
                ) : null}
                {acceptsCashOnDelivery(connection.capabilities) ? (
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.remittanceDeductsFee}
                      onChange={event => set({ remittanceDeductsFee: event.target.checked })}
                      disabled={pending}
                      className="mt-1"
                    />
                    <span>
                      {t('shipping.deductsFee')}
                      <span className="text-muted-foreground block text-xs">
                        {t('shipping.deductsFeeHint')}
                      </span>
                    </span>
                  </label>
                ) : null}
              </fieldset>
              {draft.services.length === 0 ? null : (
                <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
                  <legend className="px-1 text-sm font-medium">{t('services.legend')}</legend>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`${id}-service`}>{t('services.default')}</Label>
                    <select
                      id={`${id}-service`}
                      value={draft.defaultServiceCode}
                      onChange={event => set({ defaultServiceCode: event.target.value })}
                      disabled={pending}
                      className="border-input bg-background h-9 max-w-xs rounded-md border px-2 text-sm"
                    >
                      {draft.defaultServiceCode === '' ? (
                        <option value="">{t('services.noDefault')}</option>
                      ) : null}
                      {draft.services
                        .filter(
                          service => service.active || service.code === draft.defaultServiceCode
                        )
                        .map(service => (
                          <option key={service.code} value={service.code}>
                            {service.label}
                          </option>
                        ))}
                    </select>
                  </div>
                  <ul aria-label={t('services.legend')} className="flex flex-col gap-2">
                    {draft.services.map((service, index) => (
                      <li key={service.code} className="flex items-center gap-2">
                        <Input
                          aria-label={t('services.label', { code: service.code })}
                          value={service.label}
                          onChange={event =>
                            set({
                              services: draft.services.map((item, position) =>
                                position === index ? { ...item, label: event.target.value } : item
                              )
                            })
                          }
                          maxLength={CarrierConnectionLimits.SERVICE_LABEL_MAX_LENGTH}
                          disabled={pending}
                          aria-invalid={has('serviceLabel')}
                        />
                        <label className="flex items-center gap-1 text-sm whitespace-nowrap">
                          <input
                            type="checkbox"
                            aria-label={t('services.activeOf', { code: service.code })}
                            checked={service.active}
                            onChange={event =>
                              set({
                                services: draft.services.map((item, position) =>
                                  position === index
                                    ? { ...item, active: event.target.checked }
                                    : item
                                )
                              })
                            }
                            disabled={pending}
                          />
                          {t('services.active')}
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              )}
              {shape.savedCourier !== null ? (
                <fieldset className="grid gap-3" disabled={pending}>
                  <legend className="text-sm font-medium">{t('courier.legend')}</legend>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`${id}-courier-phone`}>{t('courier.phone')}</Label>
                    <Input
                      id={`${id}-courier-phone`}
                      value={draft.courier.phone}
                      onChange={event =>
                        set({ courier: { ...draft.courier, phone: event.target.value } })
                      }
                      maxLength={CarrierConnectionLimits.CONTACT_PHONE_MAX_LENGTH}
                      autoComplete="off"
                      aria-invalid={has('courierPhone')}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`${id}-courier-prefix`}>{t('courier.prefix')}</Label>
                    <Input
                      id={`${id}-courier-prefix`}
                      value={draft.courier.prefix}
                      onChange={event =>
                        set({
                          courier: { ...draft.courier, prefix: event.target.value.toUpperCase() }
                        })
                      }
                      maxLength={LocalGuide.PREFIX_MAX_LENGTH}
                      autoComplete="off"
                      aria-invalid={has('courierPrefix')}
                      aria-describedby={`${id}-courier-prefix-hint`}
                    />
                    <p id={`${id}-courier-prefix-hint`} className="text-muted-foreground text-xs">
                      {t('courier.prefixHint')}
                    </p>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`${id}-courier-notes`}>{t('courier.notes')}</Label>
                    <Textarea
                      id={`${id}-courier-notes`}
                      value={draft.courier.notes}
                      onChange={event =>
                        set({ courier: { ...draft.courier, notes: event.target.value } })
                      }
                      maxLength={CarrierConnectionLimits.CONTACT_NOTES_MAX_LENGTH}
                      aria-invalid={has('courierNotes')}
                    />
                  </div>
                </fieldset>
              ) : shape.fields.length > 0 ? (
                <fieldset className="grid gap-3" disabled={pending}>
                  <legend className="text-sm font-medium">{t('credentials')}</legend>
                  <p className="text-muted-foreground text-xs">{t('fieldsHint')}</p>
                  <CarrierFieldInputs
                    fields={shape.fields}
                    values={draft.fieldValues}
                    onChange={fieldValues => set({ fieldValues })}
                    disabled={pending}
                    invalid={field =>
                      has('fields') &&
                      missingFields(shape.fields, draft.fieldValues).some(
                        item => item.key === field.key
                      )
                    }
                  />
                </fieldset>
              ) : connection.hasCredentials && !hasInternalGuide(connection.capabilities) ? (
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
