'use client'

import { TriangleAlert } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type FormEvent, Fragment, type ReactElement, useState } from 'react'

import type { RemittanceLineView } from '@platform/api-client'
import { RemittanceLimits, RemittanceLineWarnings } from '@platform/core/domain'

import { centsToInput, formatCents } from '../../lib/products/money'
import {
  knownWarnings,
  type LineEditInput,
  lineEditBody
} from '../../lib/remittances/remittance-rules'
import { useUpdateRemittanceLine } from '../../lib/remittances/use-remittances'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { LineOutcomeText } from './remittance-badges'

// A line whose guide is empty is told as such, on the screen and to a screen reader
const guideOf = (guide: string, none: string): string => (guide.trim() === '' ? none : guide)

function startingInput(line: RemittanceLineView): LineEditInput {
  return {
    reported: centsToInput(line.reportedCents),
    fee: line.reportedFeeCents === null ? '' : centsToInput(line.reportedFeeCents),
    note: line.note ?? '',
    excluded: line.excluded
  }
}

// The correction of one line of a draft: what the carrier reported, its fee, a note, and leaving the line out of the
// confirmation. Only what changed is sent, and an amount that is not one is named, never read as zero.
function LineEditor({
  line,
  remittanceId,
  onDone
}: {
  line: RemittanceLineView
  remittanceId: string
  onDone: () => void
}): ReactElement {
  const t = useTranslations('remittances.lines.edit')
  const tLines = useTranslations('remittances.lines')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const update = useUpdateRemittanceLine(storeId, remittanceId)
  const [input, setInput] = useState(() => startingInput(line))
  const [badField, setBadField] = useState<'reported' | 'fee' | null>(null)
  const id = `remittance-line-${line.id}`

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const result = lineEditBody(line, input)
    if (!result.ok) {
      setBadField(result.field)
      return
    }
    setBadField(null)
    if (result.body === null) {
      onDone()
      return
    }
    update.mutate({ lineId: line.id, body: result.body }, { onSuccess: onDone })
  }

  return (
    <form
      onSubmit={submit}
      className="bg-muted/40 flex flex-col gap-3 rounded-md p-3"
      aria-label={t('label', { guide: guideOf(line.guideNumber, tLines('noGuide')) })}
    >
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-reported`}>{t('reported')}</Label>
          <Input
            id={`${id}-reported`}
            inputMode="decimal"
            autoComplete="off"
            value={input.reported}
            aria-invalid={badField === 'reported'}
            aria-describedby={badField === 'reported' ? `${id}-reported-error` : undefined}
            onChange={event => setInput({ ...input, reported: event.target.value })}
          />
          {badField === 'reported' ? (
            <p id={`${id}-reported-error`} role="alert" className="text-destructive text-sm">
              {t('invalidAmount')}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-fee`}>{t('fee')}</Label>
          <Input
            id={`${id}-fee`}
            inputMode="decimal"
            autoComplete="off"
            value={input.fee}
            aria-invalid={badField === 'fee'}
            aria-describedby={badField === 'fee' ? `${id}-fee-error` : undefined}
            onChange={event => setInput({ ...input, fee: event.target.value })}
          />
          {badField === 'fee' ? (
            <p id={`${id}-fee-error`} role="alert" className="text-destructive text-sm">
              {t('invalidAmount')}
            </p>
          ) : null}
        </div>
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <Label htmlFor={`${id}-note`}>{t('note')}</Label>
          <Input
            id={`${id}-note`}
            maxLength={RemittanceLimits.NOTE_MAX_LENGTH}
            value={input.note}
            onChange={event => setInput({ ...input, note: event.target.value })}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={input.excluded}
          onChange={event => setInput({ ...input, excluded: event.target.checked })}
        />
        {t('excluded')}
      </label>
      {update.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {errorText(update.error)}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={update.isPending}>
          {t('save')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={update.isPending}
          onClick={onDone}
        >
          {t('cancel')}
        </Button>
      </div>
    </form>
  )
}

// The lines of a remittance with the result of matching each against the shipments of the store (TDD_17 §4.15). A draft
// that the person may manage can edit a line; a settled remittance only reads.
export function RemittanceLines({
  remittanceId,
  lines,
  canEdit,
  showWarnings
}: {
  remittanceId: string
  lines: readonly RemittanceLineView[]
  canEdit: boolean
  // Only a draft is about to be confirmed: a settled remittance, or a line left out, has nothing to be warned of
  showWarnings: boolean
}): ReactElement {
  const t = useTranslations('remittances.lines')
  const format = useFormatter()
  const [editing, setEditing] = useState<string | null>(null)
  if (lines.length === 0) return <p className="text-muted-foreground text-sm">{t('empty')}</p>
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full text-left">
        <caption className="sr-only">{t('caption')}</caption>
        <thead>
          <tr className="border-b text-sm">
            <th scope="col" className="py-1 pr-3 font-medium">
              {t('columns.guide')}
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              {t('columns.order')}
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              {t('columns.outcome')}
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              {t('columns.expected')}
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              {t('columns.reported')}
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              {t('columns.fee')}
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              {t('columns.difference')}
            </th>
            {canEdit ? (
              <th scope="col" className="py-1 text-right font-medium">
                <span className="sr-only">{t('columns.actions')}</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {lines.map(line => (
            <Fragment key={line.id}>
              <tr
                className={
                  line.excluded ? 'text-muted-foreground border-b align-top' : 'border-b align-top'
                }
              >
                <td className="py-2 pr-3 text-sm whitespace-nowrap">
                  {guideOf(line.guideNumber, t('noGuide'))}
                  {line.excluded ? <span className="ml-2 text-xs">{t('leftOut')}</span> : null}
                  {line.note === null ? null : (
                    <p className="text-muted-foreground text-xs">{line.note}</p>
                  )}
                  {(showWarnings && !line.excluded ? knownWarnings(line) : []).map(warning => (
                    <p
                      key={warning}
                      className="mt-1 flex max-w-64 items-start gap-1 text-xs whitespace-normal text-amber-700 dark:text-amber-400"
                    >
                      <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
                      {t(`warnings.${warning}`)}
                    </p>
                  ))}
                </td>
                <td className="py-2 pr-3 text-sm whitespace-nowrap">{line.orderNumber ?? ''}</td>
                <td className="py-2 pr-3 text-sm">
                  <LineOutcomeText
                    outcome={line.outcome}
                    feeConsumesCash={
                      showWarnings &&
                      !line.excluded &&
                      line.expectedCents === 0 &&
                      knownWarnings(line).includes(RemittanceLineWarnings.FEE_EXCEEDS_COLLECTED)
                    }
                  />
                </td>
                <td className="py-2 pr-3 text-right text-sm whitespace-nowrap">
                  {line.expectedCents === null ? '' : formatCents(format, line.expectedCents)}
                </td>
                <td className="py-2 pr-3 text-right text-sm whitespace-nowrap">
                  {formatCents(format, line.reportedCents)}
                </td>
                <td className="py-2 pr-3 text-right text-sm whitespace-nowrap">
                  {line.reportedFeeCents === null ? '' : formatCents(format, line.reportedFeeCents)}
                </td>
                <td className="py-2 pr-3 text-right text-sm whitespace-nowrap">
                  {line.differenceCents === null ? '' : formatCents(format, line.differenceCents)}
                </td>
                {canEdit ? (
                  <td className="py-2 text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-expanded={editing === line.id}
                      aria-label={t('editLine', { guide: guideOf(line.guideNumber, t('noGuide')) })}
                      onClick={() => setEditing(editing === line.id ? null : line.id)}
                    >
                      {t('edit.open')}
                    </Button>
                  </td>
                ) : null}
              </tr>
              {canEdit && editing === line.id ? (
                <tr>
                  <td colSpan={8} className="pb-3">
                    <LineEditor
                      key={`${line.id}:${line.reportedCents}:${line.reportedFeeCents}:${line.note}:${line.excluded}`}
                      line={line}
                      remittanceId={remittanceId}
                      onDone={() => setEditing(null)}
                    />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}
