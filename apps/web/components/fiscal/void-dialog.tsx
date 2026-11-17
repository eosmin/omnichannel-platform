'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useMemo, useState } from 'react'

import { ApiError, type FiscalDocumentView } from '@platform/api-client'
import { FiscalDocumentStatus, FiscalLimits } from '@platform/core/domain'

import { useMoney } from '../../lib/finance/use-money'
import {
  useFiscalDocuments,
  useFiscalProviders,
  useVoidFiscalDocument
} from '../../lib/fiscal/use-fiscal'
import { useFiscalErrorText } from '../../lib/fiscal/use-fiscal-error-text'
import {
  EMPTY_VOID_PARTY,
  voidBodyOf,
  voidFormProblems,
  type VoidDraft,
  type VoidFormProblem,
  type VoidPartyDraft
} from '../../lib/fiscal/void-form'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { SelectField, TextField } from '../finance/fields'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

// Voids an accepted fiscal document (TDD_18 §8.3, HIGH tier). The effect is shown before anything is sent, the reason is written, and the
// action asks to be confirmed again: the invalidation goes to the authority through the provider and cannot be taken back.
export function VoidDialog({
  document,
  open,
  onOpenChange
}: {
  document: FiscalDocumentView
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.fiscal.void')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next && busy) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title', { number: document.sequenceNumber })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {open ? (
          <VoidForm document={document} onBusy={setBusy} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function VoidForm({
  document,
  onBusy,
  onDone
}: {
  document: FiscalDocumentView
  onBusy: (busy: boolean) => void
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.fiscal.void')
  const money = useMoney()
  const errorText = useFiscalErrorText()
  const run = useDestructiveAction()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const voiding = useVoidFiscalDocument(storeId)
  // What the provider that accepted the document asks besides the reason (its manifest); none is the reason alone
  const providers = useFiscalProviders(storeId, true)
  const inputs = providers.data?.find(provider => provider.id === document.providerId)?.manifest
    .voidInputs
  const [draft, setDraft] = useState<VoidDraft>({
    reason: '',
    kind: '',
    responsible: EMPTY_VOID_PARTY,
    requester: EMPTY_VOID_PARTY,
    replacementDocumentId: ''
  })
  const [problems, setProblems] = useState<readonly VoidFormProblem[]>([])
  const [refusal, setRefusal] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const identityCatalog = inputs?.identityCatalog
  const identities =
    identityCatalog === undefined
      ? null
      : (providers.data?.find(provider => provider.id === document.providerId)?.manifest.catalogs?.[
          identityCatalog
        ] ?? null)
  const needsReplacement =
    draft.kind !== '' && inputs?.kindsWithReplacement?.includes(draft.kind) === true
  // The documents that may take the place of this one: the accepted ones, asked only when the chosen kind names one
  const accepted = useFiscalDocuments(
    storeId,
    { status: FiscalDocumentStatus.ACCEPTED },
    needsReplacement
  )
  const candidates = useMemo(
    () =>
      (accepted.data?.pages.flatMap(page => page.data) ?? []).filter(
        // The ones the api takes as the replacement of this document: the same kind, provider and environment
        candidate =>
          candidate.id !== document.id &&
          candidate.kind === document.kind &&
          candidate.providerId === document.providerId &&
          candidate.environment === document.environment
      ),
    [accepted.data, document.id]
  )
  // The words for what the provider refused before it sent anything (a deadline, a person, a replacement): it names a code in `reason`
  const refusalText = (error: unknown): string => {
    const reason = error instanceof ApiError ? error.metadata['reason'] : null
    return typeof reason === 'string' && t.has(`refusals.${reason}` as 'refusals.void_not_allowed')
      ? t(`refusals.${reason}` as 'refusals.void_not_allowed')
      : errorText(error)
  }
  const change = (patch: Partial<VoidDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setProblems([])
    setRefusal(null)
  }
  const problemOf = (field: VoidFormProblem['field']): string | null => {
    const found = problems.find(candidate => candidate.field === field)
    if (found === undefined) return null
    switch (found.field) {
      case 'reason':
        return t(`problems.reason.${found.problem}`)
      case 'kind':
        return t('problems.kind.required')
      case 'replacement':
        return t('problems.replacement.required')
      case 'responsible':
        return t(`problems.responsible.${found.problem}`)
      case 'requester':
        return t(`problems.requester.${found.problem}`)
    }
  }

  useEffect(() => {
    onBusy(pending)
    return () => onBusy(false)
  }, [pending, onBusy])

  const send = async (): Promise<void> => {
    if (!guard.enter()) return
    setRefusal(null)
    setPending(true)
    try {
      await voiding.mutateAsync({ id: document.id, body: voidBodyOf(draft, inputs) })
      toast.success(t('done'))
      onDone()
    } catch (error) {
      setRefusal(refusalText(error))
    } finally {
      setPending(false)
      guard.leave()
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    // The provider's manifest is still on its way: the form asks for what it knows, and never sends a reason alone to a provider that wants more
    if (providers.data === undefined) return
    const found = voidFormProblems(
      draft,
      inputs,
      identities === null ? null : identities.map(option => option.code)
    )
    if (found.length > 0) {
      setProblems(found)
      return
    }
    run('VOID_FISCAL_DOCUMENT', {
      title: t('confirmTitle', { number: document.sequenceNumber }),
      description: t('confirmDescription'),
      confirmLabel: t('confirm'),
      onConfirm: send
    })
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <div
        className="bg-muted/50 flex flex-col gap-1 rounded-md border p-3 text-sm"
        data-testid="fiscal-void-effect"
      >
        <p className="font-medium">{t('effectTitle')}</p>
        <ul className="text-muted-foreground list-disc pl-5">
          <li>{t('effect.authority', { total: money(document.totalCents) })}</li>
          <li>{t('effect.consult')}</li>
          <li>{t('effect.irreversible')}</li>
          <li>{t('effect.replace')}</li>
        </ul>
      </div>
      <TextField
        label={t('reason')}
        value={draft.reason}
        maxLength={Math.min(
          inputs?.reasonMaxLength ?? Infinity,
          FiscalLimits.VOID_REASON_MAX_LENGTH
        )}
        disabled={pending}
        problem={problemOf('reason')}
        onChange={value => change({ reason: value })}
      />
      {providers.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {t('providersError')}{' '}
          <button type="button" className="underline" onClick={() => void providers.refetch()}>
            {t('retry')}
          </button>
        </p>
      ) : null}
      {inputs === undefined ? null : (
        <>
          <SelectField
            label={t('kind')}
            value={draft.kind}
            disabled={pending}
            problem={problemOf('kind')}
            onChange={value =>
              change({
                kind: inputs.kinds.find(kind => String(kind) === value) ?? '',
                replacementDocumentId: ''
              })
            }
          >
            <option value="">{t('kindChoose')}</option>
            {inputs.kinds.map(kind => (
              <option key={kind} value={kind}>
                {t(`kinds.${kind}`)}
              </option>
            ))}
          </SelectField>
          {needsReplacement ? (
            <SelectField
              label={t('replacement')}
              hint={t('replacementHint')}
              value={draft.replacementDocumentId}
              disabled={pending}
              problem={problemOf('replacement')}
              onChange={value => change({ replacementDocumentId: value })}
            >
              <option value="">{t('replacementChoose')}</option>
              {candidates.map(candidate => (
                <option key={candidate.id} value={candidate.id}>
                  {t('replacementOption', {
                    number: candidate.sequenceNumber,
                    total: money(candidate.totalCents)
                  })}
                </option>
              ))}
            </SelectField>
          ) : null}
          {inputs.requiresParties ? (
            <>
              <PartyFields
                prefix="responsible"
                identities={identities}
                party={draft.responsible}
                disabled={pending}
                problem={problemOf('responsible')}
                onChange={responsible => change({ responsible })}
              />
              <PartyFields
                prefix="requester"
                identities={identities}
                party={draft.requester}
                disabled={pending}
                problem={problemOf('requester')}
                onChange={requester => change({ requester })}
              />
            </>
          ) : null}
        </>
      )}
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={pending || providers.data === undefined}
        >
          {t('submit')}
        </Button>
      </div>
    </form>
  )
}

// A person of the invalidation: who makes it, or who asks for it. The kind of identity document is the provider's own code.
function PartyFields({
  prefix,
  identities,
  party,
  disabled,
  problem,
  onChange
}: {
  prefix: 'responsible' | 'requester'
  // The kinds of identity document the provider's manifest lists; none: the code is typed
  identities: readonly { code: string; label: string }[] | null
  party: VoidPartyDraft
  disabled: boolean
  problem: string | null
  onChange: (party: VoidPartyDraft) => void
}): ReactElement {
  const t = useTranslations('finance.fiscal.void')
  return (
    <fieldset className="grid gap-3 rounded-md border p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">{t(`${prefix}.title`)}</legend>
      <TextField
        label={t('party.name')}
        value={party.name}
        maxLength={FiscalLimits.VOID_PARTY_NAME_MAX_LENGTH}
        disabled={disabled}
        onChange={name => onChange({ ...party, name })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {identities === null ? (
          <TextField
            label={t('party.idType')}
            hint={t('party.idTypeHint')}
            value={party.idType}
            disabled={disabled}
            onChange={idType => onChange({ ...party, idType })}
          />
        ) : (
          <SelectField
            label={t('party.idType')}
            value={party.idType}
            disabled={disabled}
            onChange={idType => onChange({ ...party, idType })}
          >
            <option value="">{t('party.idTypeChoose')}</option>
            {identities.map(option => (
              <option key={option.code} value={option.code}>
                {`${option.code} · ${option.label}`}
              </option>
            ))}
          </SelectField>
        )}
        <TextField
          label={t('party.idNumber')}
          value={party.idNumber}
          maxLength={FiscalLimits.VOID_PARTY_ID_MAX_LENGTH}
          disabled={disabled}
          onChange={idNumber => onChange({ ...party, idNumber })}
        />
      </div>
      {problem === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {problem}
        </p>
      )}
    </fieldset>
  )
}
