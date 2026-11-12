'use client'

import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { type ChangeEvent, type ReactElement, useEffect, useMemo, useRef, useState } from 'react'

import { AppPaths, type ImportRowErrorView } from '@platform/api-client'
import {
  CarrierCapability,
  RemittanceDateFormats,
  RemittanceDecimalSeparators,
  RemittanceDelimiters,
  RemittanceImportLimits
} from '@platform/core/domain'

import { formatCents } from '../../lib/products/money'
import {
  byteLength,
  COLUMN_FIELDS,
  type ColumnField,
  contentTypeOf,
  decodeFile,
  EMPTY_FORM,
  formOf,
  guessDelimiter,
  headerSuggestions,
  ImportEncodings,
  type ImportEncoding,
  importErrorsOf,
  type MapperForm,
  mappingOf,
  sameAsProfile,
  sampleOf
} from '../../lib/remittances/import-mapper'
import {
  useDeleteImportProfile,
  useImportPreview,
  useImportProfiles,
  useImportRemittanceFile,
  useSaveImportProfile
} from '../../lib/remittances/use-remittance-import'
import { useRemittanceConnections } from '../../lib/remittances/use-remittances'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

const NEW_PROFILE = ''
const PREVIEW_DELAY_MS = 400
const NAME_MAX = 80

const DELIMITER_KEYS = {
  [RemittanceDelimiters.COMMA]: 'comma',
  [RemittanceDelimiters.SEMICOLON]: 'semicolon',
  [RemittanceDelimiters.TAB]: 'tab'
} as const
const DECIMAL_KEYS = {
  [RemittanceDecimalSeparators.DOT]: 'dot',
  [RemittanceDecimalSeparators.COMMA]: 'comma'
} as const

// The row errors of a preview or of a refused file: where it is (row and value), what is wrong, and the cell as it was. A cell
// that is not an amount is shown as the problem it is, never as zero.
function RowErrors({
  errors,
  count
}: {
  errors: readonly ImportRowErrorView[]
  count: number
}): ReactElement {
  const t = useTranslations('remittances.import.errors')
  const tAll = useTranslations()
  const codeText = (code: string): string =>
    tAll.has(`remittances.import.errors.codes.${code}` as 'errors.INTERNAL_ERROR')
      ? tAll(`remittances.import.errors.codes.${code}` as 'errors.INTERNAL_ERROR')
      : t('codes.unknown')
  return (
    <div className="flex flex-col gap-2">
      <p role="alert" className="text-destructive text-sm">
        {t('total', { count })}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{t('caption')}</caption>
          <thead>
            <tr className="border-b">
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('row')}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('field')}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('problem')}
              </th>
              <th scope="col" className="py-1 font-medium">
                {t('value')}
              </th>
            </tr>
          </thead>
          <tbody>
            {errors.map((error, index) => (
              <tr key={`${error.row}-${error.field}-${index}`} className="border-b align-top">
                <td className="py-1 pr-3 whitespace-nowrap">{error.row}</td>
                <td className="py-1 pr-3 whitespace-nowrap">
                  {error.field === null
                    ? ''
                    : tAll(`remittances.import.fields.${error.field}` as 'errors.INTERNAL_ERROR')}
                </td>
                <td className="py-1 pr-3">{codeText(error.code)}</td>
                <td className="py-1 font-mono break-all">{error.value ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {count > errors.length ? (
        <p className="text-muted-foreground text-sm">
          {t('moreNotShown', { count: errors.length })}
        </p>
      ) : null}
    </div>
  )
}

function Preview({ form, text }: { form: MapperForm; text: string }): ReactElement {
  const t = useTranslations('remittances.import.preview')
  const format = useFormatter()
  const { storeId } = useStore()
  const mapping = useMemo(() => mappingOf(form), [form])
  const sample = useMemo(() => sampleOf(text), [text])
  const wanted = useMemo(
    () =>
      mapping.ok && text !== '' && sample !== ''
        ? { text: sample, profile: mapping.profile }
        : null,
    [mapping, text, sample]
  )
  // The preview asks after the person stops typing, not at every key
  const [request, setRequest] = useState(wanted)
  useEffect(() => {
    if (wanted === null) {
      setRequest(null)
      return
    }
    const timer = setTimeout(() => setRequest(wanted), PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [wanted])
  const preview = useImportPreview(storeId, request)
  const errorText = useErrorText()
  if (sample === '') {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t('firstLineTooLarge')}
      </p>
    )
  }
  if (request === null) {
    return <p className="text-muted-foreground text-sm">{t('hint')}</p>
  }
  if (preview.isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {errorText(preview.error)}
      </p>
    )
  }
  const data = preview.data
  if (data === undefined) return <PageLoading />
  const stale = preview.isPlaceholderData || request !== wanted
  return (
    <div className="flex flex-col gap-3" aria-busy={stale}>
      <p className="text-sm">
        {t('rows', { count: data.rowCount, shown: data.lines.length })}
        {data.reference === null ? '' : ` · ${t('reference', { value: data.reference })}`}
        {data.receivedOn === null ? '' : ` · ${t('receivedOn', { value: data.receivedOn })}`}
      </p>
      {sample !== text ? <p className="text-muted-foreground text-sm">{t('sampleOnly')}</p> : null}
      {data.errorCount > 0 ? <RowErrors errors={data.errors} count={data.errorCount} /> : null}
      {data.lines.length > 0 ? (
        <div className={stale ? 'overflow-x-auto opacity-60' : 'overflow-x-auto'}>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t('caption')}</caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('columns.row')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('columns.guide')}
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {t('columns.amount')}
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  {t('columns.fee')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map(line => (
                <tr key={line.row} className="border-b">
                  <td className="py-1 pr-3 whitespace-nowrap">{line.row}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">{line.guideNumber}</td>
                  <td className="py-1 pr-3 text-right whitespace-nowrap">
                    {formatCents(format, line.reportedCents)}
                  </td>
                  <td className="py-1 text-right whitespace-nowrap">
                    {line.reportedFeeCents === undefined
                      ? ''
                      : formatCents(format, line.reportedFeeCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : data.errorCount === 0 ? (
        <p className="text-muted-foreground text-sm">{t('noLines')}</p>
      ) : null}
    </div>
  )
}

// The mapper of the settlement file of a carrier (TDD_17 §4.15): paste a table or choose a CSV or TSV (up to 5 MB), say which
// column is which, see what the api reads from a sample before anything is written, keep the mapping as a profile of the
// connection, and import: the file becomes a draft. A row the api cannot read is listed with its row, column and cell, and
// nothing is created.
export default function ImportMapperPanel(): ReactElement {
  const t = useTranslations('remittances.import')
  const tAll = useTranslations()
  const errorText = useErrorText()
  const router = useRouter()
  const { storeId } = useStore()
  const connections = useRemittanceConnections(storeId, true)
  const eligible = useMemo(
    () =>
      (connections.data ?? []).filter(connection =>
        connection.capabilities.includes(CarrierCapability.COD)
      ),
    [connections.data]
  )
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const chosenConnection = connectionId ?? eligible[0]?.id ?? null
  const profiles = useImportProfiles(storeId, chosenConnection, true)
  const [profileId, setProfileId] = useState(NEW_PROFILE)
  const profile = (profiles.data ?? []).find(entry => entry.id === profileId)
  const [form, setForm] = useState<MapperForm>(EMPTY_FORM)
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null)
  const [encoding, setEncoding] = useState<ImportEncoding>(ImportEncodings.UTF8)
  const [fileProblem, setFileProblem] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const save = useSaveImportProfile(storeId)
  const remove = useDeleteImportProfile(storeId)
  const importFile = useImportRemittanceFile(storeId)

  const mapping = mappingOf(form)
  // A file can be 5 MB: its size is worked out when the text changes, not at every key typed in the form
  const tooLarge = useMemo(() => byteLength(text) > RemittanceImportLimits.MAX_BYTES, [text])
  const suggestions = useMemo(() => headerSuggestions(text, form.delimiter), [text, form.delimiter])
  const saved = profile !== undefined && sameAsProfile(form, profile)
  const refused = importErrorsOf(importFile.error)

  // Another mapping makes the errors of the last refused import stale: they belong to the mapping that was on screen then
  const change = (patch: Partial<MapperForm>): void => {
    importFile.reset()
    setForm(current => ({ ...current, ...patch }))
  }

  // A new text or file. The delimiter is suggested only when there was no text before (never over a choice the person made)
  // and no saved mapping is picked
  const takeText = (next: string, from: string | null, suggest: boolean): void => {
    const first = text === ''
    setText(next)
    setFileName(from)
    importFile.reset()
    if (suggest && first && profile === undefined && next !== '') {
      setForm(current => ({ ...current, delimiter: guessDelimiter(next) }))
    }
  }

  // A file that cannot be used leaves no trace of the one before it: Import would otherwise send the old text
  const rejectFile = (problem: string): void => {
    setFileProblem(problem)
    setText('')
    setFileName(null)
    importFile.reset()
  }

  const readFile = async (file: File, as: ImportEncoding): Promise<void> => {
    if (file.size > RemittanceImportLimits.MAX_BYTES) {
      setFileBuffer(null)
      rejectFile('too_large')
      return
    }
    const buffer = await file.arrayBuffer()
    const decoded = decodeFile(buffer, as)
    setFileBuffer(buffer)
    if (!decoded.ok) {
      rejectFile(decoded.reason)
      return
    }
    setFileProblem(null)
    takeText(decoded.text, file.name, true)
  }

  const onFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    if (file === undefined) return
    setEncoding(ImportEncodings.UTF8)
    void readFile(file, ImportEncodings.UTF8)
  }

  const onEncoding = (next: ImportEncoding): void => {
    setEncoding(next)
    if (fileBuffer === null) return
    const decoded = decodeFile(fileBuffer, next)
    if (!decoded.ok) {
      rejectFile(decoded.reason)
      return
    }
    setFileProblem(null)
    takeText(decoded.text, fileName, false)
  }

  const choose = (id: string): void => {
    setProfileId(id)
    importFile.reset()
    const next = (profiles.data ?? []).find(entry => entry.id === id)
    if (next === undefined) {
      // Back to a new mapping: it does not keep the name of the one that was left (a second one with the same name)
      setName('')
      return
    }
    setForm(formOf(next))
    setName(next.name)
  }

  const saveMapping = (): void => {
    if (!mapping.ok || chosenConnection === null || name.trim() === '') return
    save.mutate(
      {
        profileId: profile === undefined ? null : profile.id,
        connectionId: chosenConnection,
        name: name.trim(),
        profile: mapping.profile
      },
      {
        onSuccess: result => {
          setProfileId(result.id)
          // What the api kept (it trims and collapses the text of a header, and a position is a number): the form shows that,
          // so that it is the saved mapping and Import is offered
          setForm(formOf(result))
          setName(result.name)
          toast.success(t('mapping.saved'))
        }
      }
    )
  }

  const run = (): void => {
    if (chosenConnection === null || profile === undefined || !saved || text === '') return
    importFile.mutate(
      {
        connectionId: chosenConnection,
        profileId: profile.id,
        text,
        contentType: contentTypeOf(form.delimiter)
      },
      {
        onSuccess: draft => {
          toast.success(t('action.done'))
          router.push(AppPaths.store.remittance(storeId, draft.id))
        }
      }
    )
  }

  if (connections.isError) {
    return <LoadFailed error={connections.error} onRetry={() => void connections.refetch()} />
  }
  if (connections.data === undefined) return <PageLoading />
  if (eligible.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('noConnections')}</p>
  }

  const problemText = ((): string | null => {
    if (mapping.ok) return null
    const problem = mapping.problem
    if (problem.kind === 'required') {
      return t('mapping.problems.required', {
        field: tAll(`remittances.import.fields.${problem.field}` as 'errors.INTERNAL_ERROR')
      })
    }
    if (problem.kind === 'position') {
      return t('mapping.problems.position', {
        field: tAll(`remittances.import.fields.${problem.field}` as 'errors.INTERNAL_ERROR')
      })
    }
    return t('mapping.problems.rule')
  })()
  const canImport = saved && text !== '' && !tooLarge && !importFile.isPending

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="import-source-title" className="flex flex-col gap-3">
        <h2 id="import-source-title" className="text-lg font-semibold">
          {t('source.title')}
        </h2>
        <div className="flex max-w-sm flex-col gap-1">
          <Label htmlFor="import-connection">{t('connection')}</Label>
          <select
            id="import-connection"
            className={SELECT_CLASS}
            value={chosenConnection ?? ''}
            onChange={event => {
              setConnectionId(event.target.value)
              setProfileId(NEW_PROFILE)
              setName('')
              importFile.reset()
            }}
          >
            {eligible.map(connection => (
              <option key={connection.id} value={connection.id}>
                {connection.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="import-file">{t('source.file')}</Label>
          <input
            id="import-file"
            ref={picker}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            onChange={onFile}
            className="text-sm"
          />
          <p className="text-muted-foreground text-sm">{t('source.fileHint')}</p>
        </div>
        {fileBuffer !== null ? (
          <div className="flex max-w-sm flex-col gap-1">
            <Label htmlFor="import-encoding">{t('source.encoding')}</Label>
            <select
              id="import-encoding"
              className={SELECT_CLASS}
              value={encoding}
              onChange={event => onEncoding(event.target.value as ImportEncoding)}
            >
              <option value={ImportEncodings.UTF8}>{t('source.encodings.utf8')}</option>
              <option value={ImportEncodings.WINDOWS_1252}>
                {t('source.encodings.windows1252')}
              </option>
            </select>
          </div>
        ) : null}
        {fileProblem === null ? null : (
          <p role="alert" className="text-destructive text-sm">
            {tAll(`remittances.import.source.problems.${fileProblem}` as 'errors.INTERNAL_ERROR')}
          </p>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor="import-paste">{t('source.paste')}</Label>
          <Textarea
            id="import-paste"
            rows={6}
            className="font-mono"
            value={fileName === null ? text : ''}
            placeholder={
              fileName === null
                ? t('source.pastePlaceholder')
                : t('source.fromFile', { name: fileName })
            }
            disabled={fileName !== null}
            onChange={event => takeText(event.target.value, null, true)}
          />
          {fileName === null ? null : (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => {
                setFileBuffer(null)
                setFileProblem(null)
                if (picker.current !== null) picker.current.value = ''
                takeText('', null, false)
              }}
            >
              {t('source.clearFile')}
            </Button>
          )}
          {tooLarge ? (
            <p role="alert" className="text-destructive text-sm">
              {t('source.problems.too_large')}
            </p>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="import-mapping-title" className="flex flex-col gap-3">
        <h2 id="import-mapping-title" className="text-lg font-semibold">
          {t('mapping.title')}
        </h2>
        {profiles.isError ? (
          <LoadFailed error={profiles.error} onRetry={() => void profiles.refetch()} />
        ) : (
          <div className="flex max-w-sm flex-col gap-1">
            <Label htmlFor="import-profile">{t('mapping.profile')}</Label>
            <select
              id="import-profile"
              className={SELECT_CLASS}
              value={profileId}
              onChange={event => choose(event.target.value)}
            >
              <option value={NEW_PROFILE}>{t('mapping.newProfile')}</option>
              {(profiles.data ?? []).map(entry => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="import-delimiter">{t('mapping.delimiter')}</Label>
            <select
              id="import-delimiter"
              className={SELECT_CLASS}
              value={form.delimiter}
              onChange={event =>
                change({ delimiter: event.target.value as MapperForm['delimiter'] })
              }
            >
              {Object.values(RemittanceDelimiters).map(value => (
                <option key={value} value={value}>
                  {t(`mapping.delimiters.${DELIMITER_KEYS[value]}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="import-decimal">{t('mapping.decimal')}</Label>
            <select
              id="import-decimal"
              className={SELECT_CLASS}
              value={form.decimalSeparator}
              onChange={event =>
                change({ decimalSeparator: event.target.value as MapperForm['decimalSeparator'] })
              }
            >
              {Object.values(RemittanceDecimalSeparators).map(value => (
                <option key={value} value={value}>
                  {t(`mapping.decimals.${DECIMAL_KEYS[value]}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="import-date-format">{t('mapping.dateFormat')}</Label>
            <select
              id="import-date-format"
              className={SELECT_CLASS}
              value={form.dateFormat}
              onChange={event =>
                change({ dateFormat: event.target.value as MapperForm['dateFormat'] })
              }
            >
              {Object.values(RemittanceDateFormats).map(value => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.hasHeader}
            onChange={event => change({ hasHeader: event.target.checked })}
          />
          {t('mapping.hasHeader')}
        </label>
        <div className="flex flex-wrap gap-3">
          {COLUMN_FIELDS.map((field: ColumnField) => (
            <div key={field} className="flex flex-col gap-1">
              <Label htmlFor={`import-column-${field}`}>
                {tAll(`remittances.import.fields.${field}` as 'errors.INTERNAL_ERROR')}
              </Label>
              <Input
                id={`import-column-${field}`}
                autoComplete="off"
                list={form.hasHeader ? 'import-headers' : undefined}
                inputMode={form.hasHeader ? undefined : 'numeric'}
                value={form[field]}
                onChange={event => change({ [field]: event.target.value })}
              />
            </div>
          ))}
          <datalist id="import-headers">
            {suggestions.map(header => (
              <option key={header} value={header} />
            ))}
          </datalist>
        </div>
        <p className="text-muted-foreground text-sm">
          {form.hasHeader ? t('mapping.byHeader') : t('mapping.byPosition')}
        </p>
        {problemText === null ? null : (
          <p role="status" className="text-sm">
            {problemText}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-48 flex-col gap-1">
            <Label htmlFor="import-profile-name">{t('mapping.name')}</Label>
            <Input
              id="import-profile-name"
              maxLength={NAME_MAX}
              value={name}
              onChange={event => setName(event.target.value)}
            />
          </div>
          <Button
            variant="outline"
            disabled={
              !mapping.ok ||
              name.trim() === '' ||
              save.isPending ||
              (saved && name.trim() === profile?.name)
            }
            onClick={saveMapping}
          >
            {profile === undefined ? t('mapping.save') : t('mapping.update')}
          </Button>
          {profile === undefined ? null : (
            <Button variant="outline" disabled={remove.isPending} onClick={() => setAsking(true)}>
              {t('mapping.delete')}
            </Button>
          )}
        </div>
        {save.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {errorText(save.error)}
          </p>
        ) : null}
        {remove.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {errorText(remove.error)}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="import-preview-title" className="flex flex-col gap-3">
        <h2 id="import-preview-title" className="text-lg font-semibold">
          {t('preview.title')}
        </h2>
        {text === '' ? (
          <p className="text-muted-foreground text-sm">{t('preview.empty')}</p>
        ) : (
          <Preview form={form} text={text} />
        )}
      </section>

      <section aria-labelledby="import-action-title" className="flex flex-col gap-3">
        <h2 id="import-action-title" className="text-lg font-semibold">
          {t('action.title')}
        </h2>
        <p className="text-muted-foreground text-sm">
          {saved ? t('action.description') : t('action.saveFirst')}
        </p>
        {refused !== null ? (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-destructive text-sm">
              {t('action.refused')}
            </p>
            <RowErrors errors={refused.errors} count={refused.count} />
          </div>
        ) : importFile.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {errorText(importFile.error)}
          </p>
        ) : null}
        <Button className="self-start" disabled={!canImport} onClick={run}>
          {t('action.import')}
        </Button>
      </section>

      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent aria-busy={remove.isPending}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('mapping.deleteDialog.title', { name: profile?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('mapping.deleteDialog.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              {t('mapping.deleteDialog.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={event => {
                event.preventDefault()
                if (profile === undefined) return
                remove.mutate(profile.id, {
                  onSuccess: () => {
                    setAsking(false)
                    setProfileId(NEW_PROFILE)
                    setName('')
                  },
                  onError: () => setAsking(false)
                })
              }}
            >
              {t('mapping.deleteDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
