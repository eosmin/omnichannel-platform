'use client'

import { CircleAlert, PackageCheck, PackageSearch, Pencil, ShieldAlert, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import type { ReceptionItemView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import {
  CustomerLimits,
  OrderReturnCondition,
  OrderReturnReasonKeys,
  ReturnLimits,
  type UpdateReceptionItemBody
} from '@platform/core/domain'

import { asReturnReasonKey } from '../../lib/orders/order-returns-rules'
import {
  flagIsMissingReason,
  isItemEditable,
  itemChanges,
  itemDraftOf,
  itemStateOf,
  type ReceptionItemState,
  ReceptionItemStates
} from '../../lib/returns/reception-form'
import { useCodeText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

const CONDITIONS = Object.values(OrderReturnCondition)

// One scanned package: what it is, what the agent decided about it and, once the batch ran, what happened to it. The editor opens on a
// press and sends only what changed. Flagging the customer needs customers:flag_caution; whoever lacks it neither sees the switch nor
// can undo a flag a refusal preselected for someone else (the api refuses it too).
export function ReceptionItemCard({
  item,
  locked,
  saving,
  removing,
  onSave,
  onRemove
}: {
  item: ReceptionItemView
  // The batch is being processed: nothing changes
  locked: boolean
  saving: boolean
  removing: boolean
  onSave: (itemId: string, body: UpdateReceptionItemBody) => Promise<boolean>
  onRemove: (itemId: string) => void
}): ReactElement {
  const t = useTranslations('returns.reception.item')
  const tAll = useTranslations()
  const codeText = useCodeText()
  const [editing, setEditing] = useState(false)
  const state = itemStateOf(item)
  const editable = isItemEditable(item) && !locked
  const reasonKey = asReturnReasonKey(item.reason)
  return (
    <li
      className="flex flex-col gap-3 rounded-lg border p-4"
      aria-label={t('label', { order: item.orderNumber })}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <p className="text-base font-semibold">{t('order', { number: item.orderNumber })}</p>
          <p className="text-muted-foreground text-sm">
            {item.guideNumber === null ? t('noGuide') : t('guide', { number: item.guideNumber })}
          </p>
        </div>
        <StateText state={state} />
      </div>
      <ul className="text-sm">
        {item.orderItems.map(line => (
          <li key={line.id}>
            {t('line', {
              quantity: line.quantity,
              name:
                line.variantName === null
                  ? line.productName
                  : `${line.productName} (${line.variantName})`
            })}
          </li>
        ))}
      </ul>
      <p className="text-sm">
        {reasonKey === null ? item.reason : tAll(`orders.return.reason.${reasonKey}`)}
        {' · '}
        {tAll(`orders.detail.returns.condition.${item.condition}`)}
      </p>
      {item.note === null ? null : <p className="text-muted-foreground text-sm">{item.note}</p>}
      {item.confirmDelivered ? (
        <p className="text-muted-foreground text-xs">{t('confirmedDelivered')}</p>
      ) : null}
      {item.customerIsCaution ? (
        <p className="inline-flex items-center gap-1 text-sm">
          <ShieldAlert aria-hidden className="size-4" />
          {t('customerIsCaution')}
        </p>
      ) : null}
      {item.flagCustomer ? (
        <p className="inline-flex items-center gap-1 text-sm">
          <ShieldAlert aria-hidden className="size-4" />
          {item.flagApplied ? t('flagApplied') : t('flagPlanned')}
        </p>
      ) : null}
      {item.errorCode === null ? null : (
        <p role="alert" className="text-destructive inline-flex items-start gap-1 text-sm">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {codeText(item.errorCode)}
        </p>
      )}
      {editing && editable ? (
        <ItemEditor
          item={item}
          saving={saving}
          onCancel={() => setEditing(false)}
          onSave={async body => {
            if (await onSave(item.id, body)) setEditing(false)
          }}
        />
      ) : editable ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil aria-hidden className="size-4" />
            {t('edit')}
          </Button>
          <Button
            variant="ghost"
            disabled={removing}
            onClick={() => onRemove(item.id)}
            aria-label={t('remove', { order: item.orderNumber })}
          >
            <Trash2 aria-hidden className="size-4" />
            {t('removeShort')}
          </Button>
        </div>
      ) : null}
    </li>
  )
}

function StateText({ state }: { state: ReceptionItemState }): ReactElement {
  const t = useTranslations('returns.reception.item.state')
  const Icon =
    state === ReceptionItemStates.RECEIVED
      ? PackageCheck
      : state === ReceptionItemStates.FAILED
        ? CircleAlert
        : PackageSearch
  return (
    <span className="inline-flex items-center gap-1 text-sm">
      <Icon aria-hidden className="size-4" />
      {t(state)}
    </span>
  )
}

function ItemEditor({
  item,
  saving,
  onCancel,
  onSave
}: {
  item: ReceptionItemView
  saving: boolean
  onCancel: () => void
  onSave: (body: UpdateReceptionItemBody) => Promise<void>
}): ReactElement {
  const t = useTranslations('returns.reception.editor')
  const tAll = useTranslations()
  const { can } = useStore()
  const id = useId()
  const [draft, setDraft] = useState(() => itemDraftOf(item))
  const [showProblem, setShowProblem] = useState(false)
  // A customer who is already flagged has nothing more to flag
  const mayFlag = can(ClientPermissions.CUSTOMERS_FLAG_CAUTION) && !item.customerIsCaution
  const changes = itemChanges(item, draft)
  // Only a flag the agent is deciding now needs its line: one a refusal preselected may wait for the completion's check
  const decidesFlag =
    draft.flagCustomer !== item.flagCustomer || draft.flagReason.trim() !== (item.flagReason ?? '')
  const missingReason = mayFlag && decidesFlag && flagIsMissingReason(draft)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (changes === null || saving) return
    if (missingReason) {
      setShowProblem(true)
      return
    }
    void onSave(changes)
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3 border-t pt-3"
      aria-label={t('formLabel', { order: item.orderNumber })}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-reason`}>{t('reason')}</Label>
        <select
          id={`${id}-reason`}
          className={SELECT_CLASS}
          value={draft.reason}
          onChange={event => setDraft({ ...draft, reason: event.target.value })}
        >
          {OrderReturnReasonKeys.map(key => (
            <option key={key} value={key}>
              {tAll(`orders.return.reason.${key}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-condition`}>{t('condition')}</Label>
        <select
          id={`${id}-condition`}
          className={SELECT_CLASS}
          value={draft.condition}
          onChange={event =>
            setDraft({ ...draft, condition: event.target.value as OrderReturnCondition })
          }
        >
          {CONDITIONS.map(condition => (
            <option key={condition} value={condition}>
              {tAll(`orders.detail.returns.condition.${condition}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-note`}>{t('note')}</Label>
        <Textarea
          id={`${id}-note`}
          rows={2}
          maxLength={ReturnLimits.NOTES_MAX_LENGTH}
          value={draft.note}
          onChange={event => setDraft({ ...draft, note: event.target.value })}
        />
      </div>
      {mayFlag ? (
        <fieldset className="flex flex-col gap-2 rounded-md border p-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.flagCustomer}
              onChange={event => {
                setDraft({ ...draft, flagCustomer: event.target.checked })
                setShowProblem(false)
              }}
            />
            <span>
              {t('flag')}
              <span className="text-muted-foreground block text-xs">{t('flagHint')}</span>
            </span>
          </label>
          {draft.flagCustomer ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-flag-reason`}>{t('flagReason')}</Label>
              <Input
                id={`${id}-flag-reason`}
                maxLength={CustomerLimits.CAUTION_REASON_MAX_LENGTH}
                value={draft.flagReason}
                aria-invalid={showProblem && missingReason}
                onChange={event => {
                  setDraft({ ...draft, flagReason: event.target.value })
                  setShowProblem(false)
                }}
              />
              {showProblem && missingReason ? (
                <p role="alert" className="text-destructive text-sm">
                  {t('flagNeedsReason')}
                </p>
              ) : null}
            </div>
          ) : null}
        </fieldset>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={changes === null} busy={saving}>
          {t('save')}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  )
}
