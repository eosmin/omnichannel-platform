'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import type { GuidePolicyView } from '@platform/api-client'
import {
  BenefitBase,
  BenefitLossRule,
  BenefitPeriodKind,
  BenefitRefundRule,
  BenefitReturnStatuses
} from '@platform/core/domain'

import {
  policyBody,
  type PolicyDraft,
  policyDraftOf,
  policyProblems
} from '../../lib/settings/carrier-guides-form'
import { useSavePolicy } from '../../lib/settings/use-carrier-guides'
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
import { SELECT_CLASS } from '../ui/field-classes'
import { Label } from '../ui/label'

import { GuideField } from './guide-field'

// The policy of a connection (TDD_17 §4.18): whether the balance and the refund benefit are followed, and every rule of the
// benefit. Each rule marked "to confirm" is the platform's guess about the carrier's rule until the owner confirms it with the
// carrier; the form shows it as editable, never as a fact.
export function GuidePolicyDialog({
  connectionId,
  connectionName,
  policy,
  onClose
}: {
  connectionId: string
  connectionName: string
  policy: GuidePolicyView
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.carriers.guides.policy')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const save = useSavePolicy(storeId, connectionId)
  const guard = useSubmitGuard()
  const id = useId()
  const [draft, setDraft] = useState<PolicyDraft>(() => policyDraftOf(policy))
  const [showProblems, setShowProblems] = useState(false)
  const problems = policyProblems(draft)
  const pending = save.isPending
  const set = (patch: Partial<PolicyDraft>): void => setDraft(current => ({ ...current, ...patch }))
  const bad = (problem: (typeof problems)[number]): boolean =>
    showProblems && problems.includes(problem)
  // The label of a rule that is still a guess about the carrier carries the mark
  const labelOf = (key: string, text: string): string =>
    policy.toConfirm.includes(key) ? `${text} ${t('toConfirmMark')}` : text

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (pending || !guard.enter()) return
    if (problems.length > 0) {
      setShowProblems(true)
      guard.leave()
      return
    }
    save.mutate(policyBody(draft), {
      onSuccess: () => {
        toast.success(t('done'))
        onClose()
      },
      onSettled: guard.leave
    })
  }

  const toggleStatus = (status: string, on: boolean): void =>
    set({
      returnStatuses: on
        ? [...draft.returnStatuses.filter(item => item !== status), status]
        : draft.returnStatuses.filter(item => item !== status)
    })

  return (
    <Dialog open onOpenChange={open => (open || pending ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title', { name: connectionName })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium">{t('balance.legend')}</legend>
            <Toggle
              checked={draft.balanceEnabled}
              onChange={value => set({ balanceEnabled: value })}
              disabled={pending}
              label={t('balance.enabled')}
            />
            <Toggle
              checked={draft.warnOnEmptyBalance}
              onChange={value => set({ warnOnEmptyBalance: value })}
              disabled={pending}
              label={t('balance.warnOnEmpty')}
            />
            <GuideField
              id={`${id}-low`}
              label={t('balance.low')}
              hint={t('balance.lowHint')}
              value={draft.lowBalanceThreshold}
              onChange={value => set({ lowBalanceThreshold: value })}
              inputMode="numeric"
              invalid={bad('lowBalance')}
              disabled={pending}
            />
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium">{t('benefit.legend')}</legend>
            <p className="text-muted-foreground text-xs">{t('benefit.hint')}</p>
            <Toggle
              checked={draft.benefitEnabled}
              onChange={value => set({ benefitEnabled: value })}
              disabled={pending}
              label={t('benefit.enabled')}
            />
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-kind`}>{labelOf('periodKind', t('benefit.periodKind'))}</Label>
              <select
                id={`${id}-kind`}
                className={SELECT_CLASS}
                value={draft.periodKind}
                disabled={pending}
                onChange={event =>
                  set({ periodKind: event.target.value as PolicyDraft['periodKind'] })
                }
              >
                {Object.values(BenefitPeriodKind).map(kind => (
                  <option key={kind} value={kind}>
                    {t(`benefit.periodKinds.${kind}`)}
                  </option>
                ))}
              </select>
            </div>
            {draft.periodKind === BenefitPeriodKind.FIXED_DAYS ? (
              <>
                <GuideField
                  id={`${id}-days`}
                  label={labelOf('periodDays', t('benefit.periodDays'))}
                  value={draft.periodDays}
                  onChange={value => set({ periodDays: value })}
                  inputMode="numeric"
                  invalid={bad('periodDays')}
                  disabled={pending}
                />
                <GuideField
                  id={`${id}-anchor`}
                  type="date"
                  label={t('benefit.anchor')}
                  hint={t('benefit.anchorHint')}
                  value={draft.periodAnchor}
                  onChange={value => set({ periodAnchor: value })}
                  invalid={bad('anchor')}
                  disabled={pending}
                />
              </>
            ) : null}
            <GuideField
              id={`${id}-threshold`}
              label={labelOf('thresholdBps', t('benefit.threshold'))}
              hint={t('benefit.thresholdHint')}
              value={draft.threshold}
              onChange={value => set({ threshold: value })}
              inputMode="decimal"
              invalid={bad('threshold')}
              disabled={pending}
            />
            <GuideField
              id={`${id}-warn`}
              label={t('benefit.warnAt')}
              hint={t('benefit.warnAtHint')}
              value={draft.warnAt}
              onChange={value => set({ warnAt: value })}
              inputMode="decimal"
              invalid={bad('warnAt')}
              disabled={pending}
            />
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-base`}>{labelOf('base', t('benefit.base'))}</Label>
              <select
                id={`${id}-base`}
                className={SELECT_CLASS}
                value={draft.base}
                disabled={pending}
                onChange={event => set({ base: event.target.value as PolicyDraft['base'] })}
              >
                {Object.values(BenefitBase).map(base => (
                  <option key={base} value={base}>
                    {t(`benefit.bases.${base}`)}
                  </option>
                ))}
              </select>
            </div>
            <fieldset className="grid gap-1.5">
              <legend className="text-sm font-medium">
                {labelOf('returnStatuses', t('benefit.returnStatuses'))}
              </legend>
              {BenefitReturnStatuses.map(status => (
                <Toggle
                  key={status}
                  checked={draft.returnStatuses.includes(status)}
                  onChange={value => toggleStatus(status, value)}
                  disabled={pending}
                  label={t(`benefit.statuses.${status}` as 'benefit.statuses.returned')}
                />
              ))}
            </fieldset>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-refund`}>
                {labelOf('refundRule', t('benefit.refundRule'))}
              </Label>
              <select
                id={`${id}-refund`}
                className={SELECT_CLASS}
                value={draft.refundRule}
                disabled={pending}
                onChange={event =>
                  set({ refundRule: event.target.value as PolicyDraft['refundRule'] })
                }
              >
                {Object.values(BenefitRefundRule).map(rule => (
                  <option key={rule} value={rule}>
                    {t(`benefit.refundRules.${rule}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-loss`}>{labelOf('lossRule', t('benefit.lossRule'))}</Label>
              <select
                id={`${id}-loss`}
                className={SELECT_CLASS}
                value={draft.lossRule}
                disabled={pending}
                onChange={event => set({ lossRule: event.target.value as PolicyDraft['lossRule'] })}
              >
                {Object.values(BenefitLossRule).map(rule => (
                  <option key={rule} value={rule}>
                    {t(`benefit.lossRules.${rule}`)}
                  </option>
                ))}
              </select>
            </div>
          </fieldset>

          {showProblems && problems.length > 0 ? (
            <ul role="alert" className="text-destructive list-disc pl-5 text-sm">
              {problems.map(problem => (
                <li key={problem}>{t(`problems.${problem}`)}</li>
              ))}
            </ul>
          ) : null}
          <MutationError error={save.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              {tAll('common.cancel')}
            </Button>
            <Button type="submit" disabled={pending} busy={pending}>
              {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Toggle({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (value: boolean) => void
  disabled: boolean
  label: string
}): ReactElement {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        disabled={disabled}
        className="mt-1"
      />
      <span>{label}</span>
    </label>
  )
}
