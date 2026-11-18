'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useMemo, useState } from 'react'

import type { BankPreviewReading, BankProfileView } from '@platform/api-client'

import {
  BankProfileFields,
  type BankProfileDraft,
  type BankProfileField,
  bankDraftOf,
  bankReadingOf,
  bankHeaderSuggestions,
  createBankProfileInputOf,
  DATE_FORMATS,
  DECIMAL_SEPARATORS,
  decimalKey,
  DELIMITERS,
  delimiterKey,
  emptyBankDraft,
  ENCODINGS,
  guessBankDelimiter,
  MONEY_MODE_OPTIONS,
  MoneyModes,
  skipRowsOfDraft,
  THOUSANDS_SEPARATORS,
  updateBankProfileInputOf
} from '../../lib/finance/bank-form'
import { useBankErrorText } from '../../lib/finance/use-bank-error-text'
import { useBankFile } from '../../lib/finance/use-bank-file'
import {
  useBankPreview,
  useCreateBankProfile,
  useUpdateBankProfile
} from '../../lib/finance/use-finance-bank'
import { sampleOf } from '../../lib/remittances/import-mapper'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  stickyDialogActionsClass
} from '../ui/dialog'
import { Label } from '../ui/label'

import { BankPreviewTable } from './bank-preview-table'
import { SelectField, TextField } from './fields'

// Making and editing the profile of a bank (TDD_18 §4.4): how its CSV is read. `profile` is null to make one. The preview reads a sample
// of the file with the mapping being tried and writes nothing, so a wrong column is found here and not in the middle of a statement.
export function BankProfileDialog({
  profile,
  accountId,
  open,
  onOpenChange
}: {
  profile: BankProfileView | null
  accountId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.reconciliation.profiles.dialog')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!busy) onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-2xl" data-testid="bank-profile-dialog">
        <DialogHeader>
          <DialogTitle>{profile === null ? t('createTitle') : t('editTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {open ? (
          <BankProfileForm
            key={profile?.id ?? 'new'}
            profile={profile}
            accountId={accountId}
            onDone={() => onOpenChange(false)}
            onBusy={setBusy}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

interface PreviewRequest {
  text: string
  profile: BankPreviewReading
}

// The sample of the file with the mapping being tried, or null when either is missing
function requestOf(
  reading: ReturnType<typeof bankReadingOf>,
  source: string | null
): PreviewRequest | null {
  return reading.ok && source !== null ? { text: sampleOf(source), profile: reading.value } : null
}

function BankProfileForm({
  profile,
  accountId,
  onDone,
  onBusy
}: {
  profile: BankProfileView | null
  accountId: string
  onDone: () => void
  onBusy: (busy: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.reconciliation.profiles.dialog')
  const options = useTranslations('finance.reconciliation.profiles.options')
  const errorText = useBankErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const create = useCreateBankProfile(storeId)
  const update = useUpdateBankProfile(storeId)
  const pending = create.isPending || update.isPending
  useEffect(() => {
    onBusy(pending)
    return () => onBusy(false)
  }, [pending, onBusy])
  const [draft, setDraft] = useState<BankProfileDraft>(() =>
    profile === null ? emptyBankDraft() : bankDraftOf(profile)
  )
  const [wrong, setWrong] = useState<BankProfileField | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [tried, setTried] = useState<PreviewRequest | null>(null)
  const sample = useBankFile(draft.encoding)
  const preview = useBankPreview(storeId, tried)

  const set = (patch: Partial<BankProfileDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    // A preview belongs to the mapping it was made with: a change takes it off the screen
    setTried(null)
    setWrong(null)
    setRefusal(null)
  }

  const text = sample.decoded?.ok === true ? sample.decoded.text : null
  const headers = useMemo(
    () =>
      text === null ? [] : bankHeaderSuggestions(text, draft.delimiter, skipRowsOfDraft(draft)),
    [text, draft]
  )
  const guessed = useMemo(
    () => (text === null ? null : guessBankDelimiter(text, skipRowsOfDraft(draft))),
    [text, draft]
  )

  const tryMapping = (): void => {
    const reading = bankReadingOf(draft)
    if (!reading.ok) {
      setWrong(reading.field)
      return
    }
    setTried(requestOf(reading, text))
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!guard.enter()) return
    const settle = {
      onSuccess: () => {
        toast.success(t('done'))
        onDone()
      },
      onError: (error: Error) => setRefusal(errorText(error)),
      onSettled: guard.leave
    }
    if (profile === null) {
      const input = createBankProfileInputOf(draft, accountId)
      if (!input.ok) {
        setWrong(input.field)
        guard.leave()
        return
      }
      create.mutate(input.value, settle)
      return
    }
    const input = updateBankProfileInputOf(draft)
    if (!input.ok) {
      setWrong(input.field)
      guard.leave()
      return
    }
    update.mutate({ id: profile.id, changes: input.value }, settle)
  }

  const problem = (field: BankProfileField): string | null =>
    wrong === field ? t(`problems.${field}`) : null
  const split = draft.mode === MoneyModes.SPLIT
  const columnHint = draft.hasHeader ? t('columnHintHeader') : t('columnHintPosition')

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label={t('formLabel')}>
      <TextField
        label={t('fields.name')}
        value={draft.name}
        maxLength={80}
        disabled={pending}
        problem={problem(BankProfileFields.NAME)}
        onChange={name => set({ name })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label={t('fields.delimiter')}
          value={draft.delimiter}
          disabled={pending}
          onChange={delimiter => set({ delimiter })}
        >
          {DELIMITERS.map(value => (
            <option key={value} value={value}>
              {options(`delimiter.${delimiterKey(value)}`)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('fields.encoding')}
          value={draft.encoding}
          disabled={pending}
          hint={t('fields.encodingHint')}
          onChange={encoding => set({ encoding })}
        >
          {ENCODINGS.map(value => (
            <option key={value} value={value}>
              {options(`encoding.${value}`)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('fields.decimalSeparator')}
          value={draft.decimalSeparator}
          disabled={pending}
          onChange={decimalSeparator => set({ decimalSeparator })}
        >
          {DECIMAL_SEPARATORS.map(value => (
            <option key={value} value={value}>
              {options(`decimal.${decimalKey(value)}`)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('fields.thousandsSeparator')}
          value={draft.thousandsSeparator}
          disabled={pending}
          onChange={thousandsSeparator => set({ thousandsSeparator })}
        >
          {THOUSANDS_SEPARATORS.map(value => (
            <option key={value} value={value}>
              {options(`thousands.${value}`)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('fields.dateFormat')}
          value={draft.dateFormat}
          disabled={pending}
          onChange={dateFormat => set({ dateFormat })}
        >
          {DATE_FORMATS.map(value => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('fields.window')}
          value={draft.dateWindowDays}
          inputMode="numeric"
          maxLength={2}
          disabled={pending}
          hint={t('fields.windowHint')}
          problem={problem(BankProfileFields.WINDOW)}
          onChange={dateWindowDays => set({ dateWindowDays })}
        />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={draft.hasHeader}
          disabled={pending}
          onChange={event => set({ hasHeader: event.target.checked })}
        />
        <span>
          {t('fields.hasHeader')}
          <span className="text-muted-foreground block text-xs">{t('fields.hasHeaderHint')}</span>
        </span>
      </label>

      <TextField
        label={t('fields.skipRows')}
        value={draft.skipRows}
        inputMode="numeric"
        maxLength={2}
        disabled={pending}
        hint={t('fields.skipRowsHint')}
        problem={problem(BankProfileFields.SKIP_ROWS)}
        onChange={skipRows => set({ skipRows })}
      />

      <fieldset className="flex flex-col gap-3 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{t('columns')}</legend>
        <p className="text-muted-foreground text-xs">{columnHint}</p>
        <SelectField
          label={t('fields.mode')}
          value={draft.mode}
          disabled={pending}
          onChange={mode => set({ mode: mode as BankProfileDraft['mode'] })}
        >
          {MONEY_MODE_OPTIONS.map(value => (
            <option key={value} value={value}>
              {options(`mode.${value}`)}
            </option>
          ))}
        </SelectField>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t('fields.date')}
            value={draft.date}
            disabled={pending}
            problem={problem(BankProfileFields.DATE)}
            onChange={date => set({ date })}
          />
          {split ? (
            <>
              <TextField
                label={t('fields.debit')}
                value={draft.debit}
                disabled={pending}
                hint={t('fields.debitHint')}
                problem={problem(BankProfileFields.DEBIT)}
                onChange={debit => set({ debit })}
              />
              <TextField
                label={t('fields.credit')}
                value={draft.credit}
                disabled={pending}
                hint={t('fields.creditHint')}
                problem={problem(BankProfileFields.CREDIT)}
                onChange={credit => set({ credit })}
              />
            </>
          ) : (
            <TextField
              label={t('fields.amount')}
              value={draft.amount}
              disabled={pending}
              hint={t('fields.amountHint')}
              problem={problem(BankProfileFields.AMOUNT)}
              onChange={amount => set({ amount })}
            />
          )}
          <TextField
            label={t('fields.description')}
            value={draft.description}
            disabled={pending}
            problem={problem(BankProfileFields.DESCRIPTION)}
            onChange={description => set({ description })}
          />
          <TextField
            label={t('fields.reference')}
            value={draft.reference}
            disabled={pending}
            hint={t('fields.referenceHint')}
            problem={problem(BankProfileFields.REFERENCE)}
            onChange={reference => set({ reference })}
          />
        </div>
        {wrong === BankProfileFields.RULE ? (
          <p role="alert" className="text-destructive text-sm">
            {t('problems.rule')}
          </p>
        ) : null}
      </fieldset>

      <div className="flex flex-col gap-2 rounded-md border p-3">
        <Label htmlFor="bank-sample-file">{t('sample.label')}</Label>
        <input
          id="bank-sample-file"
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
          className="text-sm"
          disabled={pending}
          onChange={event => {
            sample.onChange(event)
            setTried(null)
          }}
        />
        <p className="text-muted-foreground text-xs">{t('sample.hint')}</p>
        {sample.decoded !== null && !sample.decoded.ok ? (
          <p role="alert" className="text-destructive text-sm">
            {t(`sample.problems.${sample.decoded.reason}`)}
          </p>
        ) : null}
        {text !== null ? (
          <>
            {headers.length > 0 ? (
              <p className="text-muted-foreground text-xs" data-testid="bank-sample-headers">
                {t('sample.headers', { headers: headers.join(' | ') })}
              </p>
            ) : null}
            {guessed !== null && guessed !== draft.delimiter ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() => set({ delimiter: guessed })}
              >
                {t('sample.useDetected')}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="self-start"
              disabled={pending || preview.isFetching}
              onClick={tryMapping}
            >
              {t('sample.preview')}
            </Button>
          </>
        ) : null}
        {tried !== null && preview.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {errorText(preview.error)}
          </p>
        ) : null}
        {tried === null || preview.data === undefined ? null : (
          <BankPreviewTable preview={preview.data} />
        )}
      </div>

      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className={`${stickyDialogActionsClass} flex flex-col-reverse gap-2 sm:flex-row sm:justify-end`}>
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={pending}>
          {profile === null ? t('create') : t('save')}
        </Button>
      </div>
    </form>
  )
}
