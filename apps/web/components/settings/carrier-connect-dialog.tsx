'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import type { CarrierRegistryEntryView, ConnectedCarrierView } from '@platform/api-client'
import { CarrierConnectionLimits, LocalGuide } from '@platform/core/domain'

import {
  connectBody,
  type ConnectDraft,
  type ConnectProblem,
  connectProblems,
  declaresFields,
  EMPTY_CONNECT_DRAFT,
  hasInternalGuide
} from '../../lib/settings/carriers-form'
import { missingFields } from '../../lib/settings/connect-form'
import { useConnectCarrier } from '../../lib/settings/use-carriers'
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

import { CarrierFeeInputs } from './carrier-fee-inputs'
import { CarrierFieldInputs } from './carrier-field-inputs'

// Connect a carrier (TDD_17 §6). What the form asks for comes from what the registry says of the carrier: a courier the
// platform makes the guides for asks for its name, phone and the prefix of its guides, a carrier with an account asks for
// its credentials. Nothing here knows a carrier by name. The secret of the webhook, if the carrier pushes statuses, comes
// back once in the answer and is handed to `onConnected`.
export function CarrierConnectDialog({
  registry,
  onConnected,
  onClose
}: {
  registry: readonly CarrierRegistryEntryView[]
  onConnected: (connection: ConnectedCarrierView) => void
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.carriers.connect')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const connect = useConnectCarrier(storeId)
  const guard = useSubmitGuard()
  const id = useId()
  const [draft, setDraft] = useState<ConnectDraft>({
    ...EMPTY_CONNECT_DRAFT,
    carrierId: registry.length === 1 ? (registry[0]?.id ?? '') : ''
  })
  const [showProblems, setShowProblems] = useState(false)
  const target = registry.find(entry => entry.id === draft.carrierId)
  const problems = connectProblems(draft, target)
  const set = (patch: Partial<ConnectDraft>): void =>
    setDraft(current => ({ ...current, ...patch }))
  const has = (problem: ConnectProblem): boolean => showProblems && problems.includes(problem)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (connect.isPending || !guard.enter()) return
    if (target === undefined || problems.length > 0) {
      setShowProblems(true)
      guard.leave()
      return
    }
    connect.mutate(connectBody(draft, target), {
      onSuccess: made => {
        toast.success(t('connected', { name: made.displayName }))
        onConnected(made)
      },
      onSettled: guard.leave
    })
  }

  const internal = target !== undefined && hasInternalGuide(target.capabilities)
  const pending = connect.isPending
  return (
    <Dialog open onOpenChange={open => (open || pending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          {registry.length === 1 ? null : (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-carrier`}>{t('carrier')}</Label>
              <select
                id={`${id}-carrier`}
                value={draft.carrierId}
                onChange={event =>
                  set({
                    // What was typed for another carrier does not follow the choice
                    ...EMPTY_CONNECT_DRAFT,
                    displayName: draft.displayName,
                    isDefault: draft.isDefault,
                    carrierId: event.target.value
                  })
                }
                disabled={pending}
                aria-invalid={has('carrier')}
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              >
                <option value="">{t('carrierPlaceholder')}</option>
                {registry.map(entry => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {target === undefined ? null : (
            <>
              {internal ? (
                <>
                  <Field
                    id={`${id}-courier`}
                    label={t('courierName')}
                    value={draft.courierName}
                    onChange={value => set({ courierName: value })}
                    max={CarrierConnectionLimits.DISPLAY_NAME_MAX_LENGTH}
                    invalid={has('courierName')}
                    disabled={pending}
                  />
                  <Field
                    id={`${id}-phone`}
                    label={t('courierPhone')}
                    value={draft.courierPhone}
                    onChange={value => set({ courierPhone: value })}
                    max={CarrierConnectionLimits.CONTACT_PHONE_MAX_LENGTH}
                    invalid={has('courierPhone')}
                    disabled={pending}
                  />
                  <Field
                    id={`${id}-prefix`}
                    label={t('courierPrefix')}
                    hint={t('courierPrefixHint')}
                    value={draft.courierPrefix}
                    onChange={value => set({ courierPrefix: value.toUpperCase() })}
                    max={LocalGuide.PREFIX_MAX_LENGTH}
                    invalid={has('courierPrefix')}
                    disabled={pending}
                  />
                  <div className="grid gap-1.5">
                    <Label htmlFor={`${id}-notes`}>{t('courierNotes')}</Label>
                    <Textarea
                      id={`${id}-notes`}
                      value={draft.courierNotes}
                      onChange={event => set({ courierNotes: event.target.value })}
                      maxLength={CarrierConnectionLimits.CONTACT_NOTES_MAX_LENGTH}
                      disabled={pending}
                      aria-invalid={has('courierNotes')}
                    />
                  </div>
                </>
              ) : declaresFields(target) ? (
                <CarrierFieldInputs
                  fields={target.connectFields}
                  values={draft.fieldValues}
                  onChange={fieldValues => set({ fieldValues })}
                  disabled={pending}
                  invalid={field =>
                    has('fields') &&
                    missingFields(target.connectFields, draft.fieldValues).some(
                      item => item.key === field.key
                    )
                  }
                />
              ) : target.hasCredentials ? (
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
              <CarrierFeeInputs
                fees={target.feeSettings}
                commission={draft.commission}
                rates={draft.rates}
                onChange={change => set(change)}
                disabled={pending}
                commissionInvalid={has('commission')}
                ratesInvalid={has('rates')}
              />
              <Field
                id={`${id}-name`}
                label={t('displayName')}
                hint={t('displayNameHint')}
                value={draft.displayName}
                onChange={value => set({ displayName: value })}
                max={CarrierConnectionLimits.DISPLAY_NAME_MAX_LENGTH}
                invalid={has('name')}
                disabled={pending}
              />
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.isDefault}
                  onChange={event => set({ isDefault: event.target.checked })}
                  disabled={pending}
                  className="mt-1"
                />
                <span>{t('isDefault')}</span>
              </label>
            </>
          )}
          {showProblems && problems.length > 0 ? (
            <ul role="alert" className="text-destructive list-disc pl-5 text-sm">
              {problems.map(problem => (
                <li key={problem}>{t(`problems.${problem}`)}</li>
              ))}
            </ul>
          ) : null}
          <MutationError error={connect.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              {tAll('common.cancel')}
            </Button>
            <Button type="submit" disabled={pending || target === undefined} busy={pending}>
              {pending ? t('connecting') : t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  max,
  invalid,
  disabled
}: {
  id: string
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  max: number
  invalid: boolean
  disabled: boolean
}): ReactElement {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={event => onChange(event.target.value)}
        maxLength={max}
        autoComplete="off"
        disabled={disabled}
        aria-invalid={invalid}
      />
      {hint === undefined ? null : <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  )
}
