'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import { ApiError, type FiscalIssuerView, type FiscalProviderView } from '@platform/api-client'
import { FiscalFieldLimits, FiscalIssueOn } from '@platform/core/domain'

import {
  type CatalogOption,
  catalogOf,
  emptyIssuerDraft,
  type IssuerDraft,
  type IssuerField,
  IssuerFields,
  issuerDraftOf,
  issuerInputOf,
  type IssuerProblem,
  issuerProblems,
  SEQUENCE_DIGITS
} from '../../lib/fiscal/issuer-form'
import { usePutFiscalIssuer } from '../../lib/fiscal/use-fiscal'
import { useFiscalErrorText } from '../../lib/fiscal/use-fiscal-error-text'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { SelectField, TextField } from '../finance/fields'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { AddressRowsField } from './address-rows-field'

// The issuer of the organization (TDD_18 §8.2). What the form asks follows the manifest of the provider that is chosen: the fields it
// cannot work without, the names of its credentials and the environments it works in. The form names no provider and no country.
export function IssuerForm({
  providers,
  issuer,
  canManage,
  onSaved
}: {
  providers: readonly FiscalProviderView[]
  issuer: FiscalIssuerView | null
  canManage: boolean
  // Called after a save, for the page to start the form again from what the api now has
  onSaved: () => void
}): ReactElement {
  const t = useTranslations('finance.fiscal.issuer')
  const errorText = useFiscalErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const save = usePutFiscalIssuer(storeId)
  const [draft, setDraft] = useState<IssuerDraft>(() =>
    issuer === null ? emptyIssuerDraft(providers[0]) : issuerDraftOf(issuer)
  )
  const [problems, setProblems] = useState<IssuerProblem[]>([])
  const [refusal, setRefusal] = useState<string | null>(null)
  const [codes, setCodes] = useState<string[]>([])
  const provider = providers.find(candidate => candidate.id === draft.providerId)
  const contingency = provider?.contingency ?? null

  const set = (changes: Partial<IssuerDraft>): void => {
    setDraft(current => ({ ...current, ...changes }))
    setProblems([])
    setRefusal(null)
    setCodes([])
  }
  const problemOf = (field: IssuerField): IssuerProblem | undefined =>
    problems.find(problem => problem.field === field)
  const wordsOf = (field: IssuerField): string | null => {
    const problem = problemOf(field)
    return problem === undefined ? null : t(`problems.${problem.kind}`)
  }
  const pending = save.isPending
  const locked = !canManage || pending
  const changedProvider =
    issuer !== null &&
    (issuer.providerId !== draft.providerId || String(issuer.environment) !== draft.environment)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (provider === undefined) return
    const found = issuerProblems(draft, provider, issuer)
    if (found.length > 0) {
      setProblems(found)
      return
    }
    if (!guard.enter()) return
    // The page starts the form again from what the api now has (its key is the time of the last save), so nothing is set after a save
    // and the answer is read here, not in per-call callbacks that a remount would skip
    void save
      .mutateAsync(issuerInputOf(draft, provider))
      .then(() => {
        toast.success(t('done'))
        onSaved()
      })
      .catch((error: unknown) => {
        setRefusal(errorText(error))
        // The codes the provider chose for what it did not accept (a field, a certificate), never a value
        const named = error instanceof ApiError ? error.metadata['problems'] : null
        setCodes(
          Array.isArray(named)
            ? named.filter((code): code is string => typeof code === 'string')
            : []
        )
      })
      .finally(guard.leave)
  }

  const requires = (field: string): boolean =>
    provider?.manifest.requiredIssuerFields.includes(field) === true
  // A field the provider does not ask for is shown only when the issuer has a value in it, so that a person can still read it and clear it
  const shows = (field: string, value: string): boolean => requires(field) || value.trim() !== ''
  const mark = (label: string, field: string): string =>
    requires(field) ? `${label} ${t('requiredMark')}` : label

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex max-w-2xl flex-col gap-4"
      aria-label={t('formLabel')}
      data-testid="fiscal-issuer-form"
    >
      <SelectField
        label={t('provider')}
        value={draft.providerId}
        disabled={locked}
        problem={wordsOf(IssuerFields.PROVIDER)}
        onChange={value => {
          const next = providers.find(candidate => candidate.id === value)
          set({
            providerId: value,
            environment: next?.manifest.environments[0] ?? draft.environment,
            // A code of the lists of the other provider is not a code of this one
            activityCode: '',
            establishmentType: '',
            credentials: {}
          })
        }}
      >
        {providers.map(candidate => (
          <option key={candidate.id} value={candidate.id}>
            {t('providerOption', { id: candidate.id, country: candidate.countryCode })}
          </option>
        ))}
      </SelectField>
      {provider === undefined ? (
        <p role="alert" className="text-destructive text-sm" data-testid="fiscal-provider-missing">
          {t('providerMissing')}
        </p>
      ) : null}
      {contingency === null ? null : (
        <p className="text-muted-foreground text-xs" data-testid="fiscal-contingency">
          {t('contingency', { text: contingency })}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label={t('environment')}
          value={draft.environment}
          disabled={locked}
          problem={wordsOf(IssuerFields.ENVIRONMENT)}
          // A key of one environment is never the key of the other
          onChange={environment => set({ environment, credentials: {} })}
        >
          {(provider?.manifest.environments ?? []).map(environment => (
            <option key={environment} value={environment}>
              {t(`environments.${environment}`)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('issueOn')}
          value={draft.issueOn}
          disabled={locked}
          hint={t('issueOnHint')}
          onChange={issueOn => set({ issueOn })}
        >
          {Object.values(FiscalIssueOn).map(moment => (
            <option key={moment} value={moment}>
              {t(`issueOnOptions.${moment}`)}
            </option>
          ))}
        </SelectField>
      </div>
      {changedProvider ? (
        <p
          role="note"
          className="bg-muted/50 rounded-md border p-3 text-sm"
          data-testid="fiscal-issuer-change"
        >
          {t('changeNotice')}
        </p>
      ) : null}
      <TextField
        label={mark(t('legalName'), IssuerFields.LEGAL_NAME)}
        value={draft.legalName}
        maxLength={FiscalFieldLimits.NAME}
        disabled={locked}
        problem={wordsOf(IssuerFields.LEGAL_NAME)}
        onChange={legalName => set({ legalName })}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={mark(t('taxId'), IssuerFields.TAX_ID)}
          value={draft.taxId}
          maxLength={FiscalFieldLimits.TAX_ID}
          disabled={locked}
          problem={wordsOf(IssuerFields.TAX_ID)}
          onChange={taxId => set({ taxId })}
        />
        <TextField
          label={mark(t('registrationId'), IssuerFields.REGISTRATION_ID)}
          value={draft.registrationId}
          maxLength={FiscalFieldLimits.REGISTRATION_ID}
          disabled={locked}
          problem={wordsOf(IssuerFields.REGISTRATION_ID)}
          onChange={registrationId => set({ registrationId })}
        />
        <CodeField
          label={mark(t('activityCode'), IssuerFields.ACTIVITY_CODE)}
          value={draft.activityCode}
          options={catalogOf(provider, IssuerFields.ACTIVITY_CODE)}
          disabled={locked}
          problem={wordsOf(IssuerFields.ACTIVITY_CODE)}
          onChange={activityCode => set({ activityCode })}
        />
        <TextField
          label={mark(t('establishmentCode'), IssuerFields.ESTABLISHMENT_CODE)}
          value={draft.establishmentCode}
          maxLength={FiscalFieldLimits.CODE}
          disabled={locked}
          problem={wordsOf(IssuerFields.ESTABLISHMENT_CODE)}
          onChange={establishmentCode => set({ establishmentCode })}
        />
        {shows(IssuerFields.ESTABLISHMENT_TYPE, draft.establishmentType) ? (
          <CodeField
            label={mark(t('establishmentType'), IssuerFields.ESTABLISHMENT_TYPE)}
            value={draft.establishmentType}
            options={catalogOf(provider, IssuerFields.ESTABLISHMENT_TYPE)}
            disabled={locked}
            problem={wordsOf(IssuerFields.ESTABLISHMENT_TYPE)}
            onChange={establishmentType => set({ establishmentType })}
          />
        ) : null}
        {shows(IssuerFields.POINT_OF_SALE_CODE, draft.pointOfSaleCode) ? (
          <TextField
            label={mark(t('pointOfSaleCode'), IssuerFields.POINT_OF_SALE_CODE)}
            value={draft.pointOfSaleCode}
            maxLength={FiscalFieldLimits.CODE}
            disabled={locked}
            problem={wordsOf(IssuerFields.POINT_OF_SALE_CODE)}
            onChange={pointOfSaleCode => set({ pointOfSaleCode })}
          />
        ) : null}
        {shows(IssuerFields.PHONE, draft.phone) ? (
          <TextField
            label={mark(t('phone'), IssuerFields.PHONE)}
            value={draft.phone}
            maxLength={FiscalFieldLimits.PHONE}
            disabled={locked}
            problem={wordsOf(IssuerFields.PHONE)}
            onChange={phone => set({ phone })}
          />
        ) : null}
        {shows(IssuerFields.EMAIL, draft.email) ? (
          <TextField
            label={mark(t('email'), IssuerFields.EMAIL)}
            value={draft.email}
            maxLength={FiscalFieldLimits.EMAIL}
            disabled={locked}
            problem={wordsOf(IssuerFields.EMAIL)}
            onChange={email => set({ email })}
          />
        ) : null}
      </div>
      <AddressRowsField
        rows={draft.address}
        onChange={address => set({ address })}
        disabled={locked}
        hint={t('addressHint')}
        required={requires(IssuerFields.ADDRESS)}
        problem={wordsOf(IssuerFields.ADDRESS)}
      />
      <TextField
        label={t('nextSequence')}
        value={draft.nextSequence}
        inputMode="numeric"
        maxLength={SEQUENCE_DIGITS}
        disabled={locked}
        hint={
          issuer === null
            ? t('nextSequenceFirst')
            : t('nextSequenceHint', { next: issuer.nextSequence })
        }
        problem={wordsOf(IssuerFields.NEXT_SEQUENCE)}
        onChange={nextSequence => set({ nextSequence })}
      />
      <Credentials
        provider={provider}
        draft={draft}
        credentialsSet={issuer?.credentialsSet === true}
        disabled={locked}
        problem={wordsOf(IssuerFields.CREDENTIALS)}
        onChange={credentials => set({ credentials })}
      />
      {refusal === null ? null : (
        <div role="alert" className="text-destructive flex flex-col gap-1 text-sm">
          <p>{refusal}</p>
          {codes.length === 0 ? null : (
            <p data-testid="fiscal-issuer-problems">
              {t('providerProblems', { codes: codes.join(', ') })}
            </p>
          )}
        </div>
      )}
      {canManage ? (
        <div className="flex justify-end">
          <Button type="submit" disabled={pending || provider === undefined}>
            {t('submit')}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{t('readOnly')}</p>
      )}
    </form>
  )
}

// A code the provider reads: chosen from the list its manifest names for the field (the code with its words), or typed when it names none.
// A code the issuer already has that the list does not know stays as an option, so that it is read and told, never dropped.
function CodeField({
  label,
  value,
  options,
  disabled,
  problem,
  onChange
}: {
  label: string
  value: string
  options: readonly CatalogOption[] | null
  disabled: boolean
  problem: string | null
  onChange: (value: string) => void
}): ReactElement {
  const t = useTranslations('finance.fiscal.issuer')
  if (options === null) {
    return (
      <TextField
        label={label}
        value={value}
        maxLength={FiscalFieldLimits.CODE}
        disabled={disabled}
        problem={problem}
        onChange={onChange}
      />
    )
  }
  const known = options.some(option => option.code === value.trim())
  return (
    <SelectField
      label={label}
      value={value}
      disabled={disabled}
      problem={problem}
      onChange={onChange}
    >
      <option value="">{t('choose')}</option>
      {value !== '' && !known ? <option value={value}>{value}</option> : null}
      {options.map(option => (
        <option key={option.code} value={option.code}>
          {`${option.code} · ${option.label}`}
        </option>
      ))}
    </SelectField>
  )
}

// The credentials are written and never read back: the screen says whether there are some, and what is typed replaces them all
function Credentials({
  provider,
  draft,
  credentialsSet,
  disabled,
  problem,
  onChange
}: {
  provider: FiscalProviderView | undefined
  draft: IssuerDraft
  credentialsSet: boolean
  disabled: boolean
  problem: string | null
  onChange: (credentials: Record<string, string>) => void
}): ReactElement | null {
  const t = useTranslations('finance.fiscal.issuer.credentials')
  const id = useId()
  const keys = provider?.manifest.credentialKeys ?? []
  if (keys.length === 0) return null
  return (
    <fieldset
      className="grid gap-2"
      aria-describedby={problem === null ? undefined : `${id}-error`}
    >
      <legend className="text-sm font-medium">{t('legend')}</legend>
      <p className="text-muted-foreground text-xs" data-testid="fiscal-credentials-state">
        {credentialsSet ? t('stored') : t('none')}
      </p>
      <p className="text-muted-foreground text-xs">{t('hint')}</p>
      {keys.map(key => (
        <div key={key} className="grid gap-1.5">
          <Label htmlFor={`${id}-${key}`}>{key}</Label>
          <Input
            id={`${id}-${key}`}
            type="password"
            autoComplete="new-password"
            value={draft.credentials[key] ?? ''}
            maxLength={FiscalFieldLimits.CREDENTIAL_VALUE}
            disabled={disabled}
            onChange={event => onChange({ ...draft.credentials, [key]: event.target.value })}
          />
        </div>
      ))}
      {problem === null ? null : (
        <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
          {problem}
        </p>
      )}
    </fieldset>
  )
}
