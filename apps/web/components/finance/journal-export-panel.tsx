'use client'

import { Download } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import {
  journalCsvInputOf,
  journalFileName,
  type ReportRangeDraft,
  type ReportRangeProblem,
  reportRangeProblem
} from '../../lib/finance/report-form'
import { saveCsvFile } from '../../lib/finance/save-file'
import { useDownloadJournalCsv } from '../../lib/finance/use-finance-reports'
import { useSubmitGuard } from '../../lib/submit-guard'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { TextField } from './fields'

// The file of the journal for the auditor (TDD_18 §11): one row per line, with every field the hash of each entry covers, so a person
// holding only the file can check the chain. The api refuses a file it would have to cut (too many rows) and says which range to narrow.
export function JournalExportPanel(): ReactElement {
  const t = useTranslations('finance.reports.journal')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const download = useDownloadJournalCsv(storeId)
  const guard = useSubmitGuard()
  const [draft, setDraft] = useState<ReportRangeDraft>({ from: '', to: '' })
  const [wrong, setWrong] = useState<ReportRangeProblem | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = reportRangeProblem(draft, { bothEnds: true })
    setWrong(problem)
    if (problem !== null) return
    if (!guard.enter()) return
    setRefusal(null)
    // The name is of the range that was asked, whatever the fields say when the file arrives
    const name = journalFileName(draft)
    download.mutate(journalCsvInputOf(draft), {
      onSuccess: text => saveCsvFile(name, text),
      onError: error => setRefusal(errorText(error)),
      onSettled: guard.leave
    })
  }

  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="finance-journal-title"
      data-testid="finance-journal-export"
    >
      <header className="flex flex-col gap-1">
        <h2 id="finance-journal-title" className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <form
        onSubmit={submit}
        noValidate
        className="grid gap-3 sm:grid-cols-2"
        aria-label={t('formLabel')}
      >
        <TextField
          label={t('from')}
          hint={t('dayHint')}
          value={draft.from}
          maxLength={10}
          disabled={download.isPending}
          problem={
            wrong === 'from' ? t('problems.from') : wrong === 'order' ? t('problems.order') : null
          }
          onChange={from => {
            setDraft(current => ({ ...current, from }))
            setWrong(null)
          }}
        />
        <TextField
          label={t('to')}
          hint={t('dayHint')}
          value={draft.to}
          maxLength={10}
          disabled={download.isPending}
          problem={
            wrong === 'to' ? t('problems.to') : wrong === 'length' ? t('problems.length') : null
          }
          onChange={to => {
            setDraft(current => ({ ...current, to }))
            setWrong(null)
          }}
        />
        <div className="sm:col-span-2">
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={download.isPending}
            busy={download.isPending}
          >
            <Download aria-hidden />
            {t('download')}
          </Button>
        </div>
      </form>
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
    </section>
  )
}
