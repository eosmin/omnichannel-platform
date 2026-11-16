'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useRef, useState } from 'react'

import type { BankImportView } from '@platform/api-client'
import {
  BankStatementEncodings,
  BankStatementFiles,
  BankStatementLimits,
  RemittanceDelimiters
} from '@platform/core/domain'

import {
  type BankImportDraft,
  type BankImportField,
  BankImportFields,
  bankDateFormatPromptOf,
  bankImportErrorsOf,
  emptyImportDraft,
  importInputOf
} from '../../lib/finance/bank-statement'
import { useBankErrorText } from '../../lib/finance/use-bank-error-text'
import { useBankFile } from '../../lib/finance/use-bank-file'
import { useBankProfiles, useImportBankStatement } from '../../lib/finance/use-finance-bank'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Label } from '../ui/label'

import { BankRowErrors } from './bank-preview-table'
import { SelectField, TextField } from './fields'

// Importing the statement of a bank (TDD_18 §4.4): the file, read with the profile the person chose, and the balance it ends with when
// they know it. The api checks the size (5 MB) and the rows (5000) and refuses the WHOLE file when one row cannot be read: it is never
// imported half, and the screen lists every row the api names. Importing reconciles nothing: it only brings the lines in.
export function BankImportDialog({
  accountId,
  open,
  onOpenChange,
  onImported
}: {
  accountId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (imported: BankImportView) => void
}): ReactElement {
  const t = useTranslations('finance.reconciliation.imports.dialog')
  // Escape and a click outside do nothing while the file is being imported: the answer (the statement, or the rows refused) is for this form
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!busy) onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-xl" data-testid="bank-import-dialog">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description', {
              megabytes: BankStatementLimits.MAX_BYTES / (1024 * 1024),
              rows: BankStatementLimits.MAX_ROWS
            })}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <BankImportForm
            accountId={accountId}
            onDone={() => onOpenChange(false)}
            onImported={onImported}
            onBusy={setBusy}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function BankImportForm({
  accountId,
  onDone,
  onImported,
  onBusy
}: {
  accountId: string
  onDone: () => void
  onImported: (imported: BankImportView) => void
  onBusy: (busy: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.reconciliation.imports.dialog')
  const errorText = useBankErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const profiles = useBankProfiles(storeId, accountId, true)
  const importing = useImportBankStatement(storeId)
  const importPending = importing.isPending
  useEffect(() => {
    onBusy(importPending)
    return () => onBusy(false)
  }, [importPending, onBusy])
  const [draft, setDraft] = useState<BankImportDraft>(() => emptyImportDraft())
  const [wrong, setWrong] = useState<BankImportField | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<ReturnType<typeof bankImportErrorsOf>>(null)
  // Every date of the file reads in both orders of the day and the month: the person says the order of the profile is the right one
  const [datePrompt, setDatePrompt] = useState<ReturnType<typeof bankDateFormatPromptOf>>(null)

  const profile = profiles.data?.find(candidate => candidate.id === draft.profileId)
  // The profile says how the bytes become text
  const fileInput = useRef<HTMLInputElement>(null)
  const file = useBankFile(profile?.encoding ?? BankStatementEncodings.UTF8)

  const set = (patch: Partial<BankImportDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setWrong(null)
    setRefusal(null)
    setRowErrors(null)
  }
  // Another profile or another file is another reading: what was confirmed for the last one does not carry over
  const reread = (patch: Partial<BankImportDraft>): void => {
    setDatePrompt(null)
    set({ ...patch, dateFormatConfirmed: false })
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    // Only a file that reads as text with the encoding of the profile is sent, and it is sent as the bytes it is
    const readable = file.decoded?.ok === true ? file.bytes : null
    const input = importInputOf(
      draft,
      readable === null
        ? null
        : {
            bytes: readable,
            contentType:
              profile?.delimiter === RemittanceDelimiters.TAB
                ? BankStatementFiles.TSV.contentType
                : BankStatementFiles.CSV.contentType
          }
    )
    if (!input.ok) {
      setWrong(input.field)
      return
    }
    if (!guard.enter()) return
    importing.mutate(input.value, {
      onSuccess: imported => {
        toast.success(t('done', { added: imported.newLineCount }))
        onDone()
        onImported(imported)
      },
      onError: error => {
        const prompt = bankDateFormatPromptOf(error)
        setDatePrompt(prompt)
        // The box is only on screen with the question: what was ticked for a refusal that is not the question is forgotten
        if (prompt === null) setDraft(current => ({ ...current, dateFormatConfirmed: false }))
        const issues = bankImportErrorsOf(error)
        setRowErrors(issues)
        setRefusal(issues === null && prompt === null ? errorText(error) : null)
        if (issues !== null) {
          // The file is refused whole: it is fixed and chosen again, so the old bytes are forgotten and the input is empty
          file.reset()
          if (fileInput.current !== null) fileInput.current.value = ''
        }
      },
      onSettled: guard.leave
    })
  }

  const problem = (field: BankImportField): string | null =>
    wrong === field ? t(`problems.${field}`) : null

  if (profiles.isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {errorText(profiles.error)}
      </p>
    )
  }
  if (profiles.data !== undefined && profiles.data.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm" data-testid="bank-import-no-profile">
          {t('noProfile')}
        </p>
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={onDone}>
            {t('cancel')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <SelectField
        label={t('profile')}
        value={draft.profileId}
        disabled={importing.isPending || profiles.data === undefined}
        problem={problem(BankImportFields.PROFILE)}
        onChange={profileId => reread({ profileId })}
      >
        <option value="">{t('chooseProfile')}</option>
        {(profiles.data ?? []).map(option => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </SelectField>
      <div className="grid gap-1.5">
        <Label htmlFor="bank-statement-file">{t('file')}</Label>
        <input
          id="bank-statement-file"
          ref={fileInput}
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
          className="text-sm"
          disabled={importing.isPending}
          onChange={event => {
            file.onChange(event)
            reread({})
          }}
        />
        <p className="text-muted-foreground text-xs">{t('fileHint')}</p>
        {profile !== undefined && file.decoded !== null && !file.decoded.ok ? (
          <p role="alert" className="text-destructive text-sm">
            {t(`fileProblems.${file.decoded.reason}`)}
          </p>
        ) : null}
        {wrong === BankImportFields.FILE ? (
          <p role="alert" className="text-destructive text-sm">
            {t('problems.file')}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          label={t('closingBalance')}
          value={draft.closingBalance}
          inputMode="decimal"
          maxLength={16}
          disabled={importing.isPending}
          hint={t('closingBalanceHint')}
          problem={problem(BankImportFields.CLOSING_BALANCE)}
          onChange={closingBalance => set({ closingBalance })}
        />
        <TextField
          label={t('closingOn')}
          value={draft.closingOn}
          maxLength={10}
          disabled={importing.isPending}
          hint={t('closingOnHint')}
          problem={problem(BankImportFields.CLOSING_ON)}
          onChange={closingOn => set({ closingOn })}
        />
      </div>
      {datePrompt === null ? null : (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border p-3"
          data-testid="bank-date-format"
        >
          <p className="text-sm font-medium">{t('dateFormat.title')}</p>
          <p className="text-muted-foreground text-sm">
            {t('dateFormat.hint', {
              format: datePrompt.dateFormat,
              from: datePrompt.firstDay,
              to: datePrompt.lastDay
            })}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.dateFormatConfirmed === true}
              disabled={importing.isPending}
              onChange={event => set({ dateFormatConfirmed: event.target.checked })}
            />
            {t('dateFormat.confirm')}
          </label>
        </div>
      )}
      {rowErrors === null ? null : (
        <BankRowErrors errors={rowErrors.errors} count={rowErrors.count} />
      )}
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onDone} disabled={importing.isPending}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={importing.isPending}>
          {t('submit')}
        </Button>
      </div>
    </form>
  )
}
