'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type { CustomerListItemView, CustomerMergePreviewView } from '@platform/api-client'
import {
  CustomerLimits,
  MergeFieldSources,
  type MergeableField,
  type MergeFieldSource
} from '@platform/core/domain'

import { customerListLabel } from '../../lib/customers/customer-name'
import { fieldChoicesOf, knownConflicts } from '../../lib/customers/merge-form'
import {
  type CustomerMerges,
  useCustomerList,
  useCustomerMerges,
  useMergePreview
} from '../../lib/customers/use-customer-data'
import { phraseMatches } from '../../lib/destructive-action'
import { useDebouncedValue } from '../../lib/use-debounced-value'
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

import { MutationError } from './mutation-error'

const SEARCH_DELAY_MS = 300

type Picks = Partial<Record<MergeableField, MergeFieldSource>>
type Step = 'pick' | 'review' | 'confirm'

// Merge with another customer (TDD_09 §6.1): search the duplicate, see what the merge would give, choose
// which contact data to keep where the two differ, and confirm by typing a word. The customer who is
// open is the one that stays (the survivor). `absorbedId` skips the search, for "Merge instead".
export function MergeDialog({
  survivorId,
  absorbedId,
  onClose
}: {
  survivorId: string
  absorbedId?: string
  onClose: () => void
}): ReactElement {
  const t = useTranslations('customers.merge')
  const [chosenId, setChosenId] = useState<string | null>(absorbedId ?? null)
  const [step, setStep] = useState<Step>(absorbedId === undefined ? 'pick' : 'review')
  const [picks, setPicks] = useState<Picks>({})
  const { storeId } = useStore()
  const { merge } = useCustomerMerges(storeId, survivorId)

  return (
    // Not closed while the merge runs: the answer, a refusal included, must reach the user
    <Dialog open onOpenChange={open => (open || merge.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t(`steps.${step}`)}</DialogDescription>
        </DialogHeader>
        {step === 'pick' || chosenId === null ? (
          <PickStep
            survivorId={survivorId}
            onPick={id => {
              setChosenId(id)
              setPicks({})
              setStep('review')
            }}
          />
        ) : (
          <Merge
            survivorId={survivorId}
            absorbedId={chosenId}
            step={step}
            merge={merge}
            picks={picks}
            onPick={(field, source) => setPicks(current => ({ ...current, [field]: source }))}
            onStep={setStep}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PickStep({
  survivorId,
  onPick
}: {
  survivorId: string
  onPick: (customerId: string) => void
}): ReactElement {
  const t = useTranslations('customers.merge')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const [text, setText] = useState('')
  const q = useDebouncedValue(text.trim(), SEARCH_DELAY_MS)
  const customers = useCustomerList(storeId, q, true)
  const rows = (customers.data?.pages.flatMap(page => page.data) ?? []).filter(
    customer => customer.id !== survivorId
  )
  return (
    <div className="flex flex-col gap-3">
      <Label htmlFor="merge-search" className="sr-only">
        {t('searchLabel')}
      </Label>
      <Input
        id="merge-search"
        type="search"
        autoFocus
        placeholder={t('searchPlaceholder')}
        maxLength={CustomerLimits.SEARCH_MAX_LENGTH}
        value={text}
        onChange={event => setText(event.target.value)}
      />
      {customers.isPending ? (
        <p role="status" className="text-muted-foreground text-sm">
          {tAll('common.loading')}
        </p>
      ) : null}
      {customers.isError && rows.length === 0 ? (
        <p role="alert" className="text-sm">
          {t('searchFailed')}
        </p>
      ) : null}
      {customers.isSuccess && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('noMatches')}</p>
      ) : null}
      <ul className="flex max-h-72 flex-col overflow-y-auto">
        {rows.map(customer => (
          <li key={customer.id}>
            <CandidateButton customer={customer} onPick={onPick} />
          </li>
        ))}
      </ul>
      {customers.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={customers.isFetchingNextPage}
          onClick={() => void customers.fetchNextPage()}
        >
          {tAll('customers.list.loadMore')}
        </Button>
      ) : null}
    </div>
  )
}

function CandidateButton({
  customer,
  onPick
}: {
  customer: CustomerListItemView
  onPick: (customerId: string) => void
}): ReactElement {
  const t = useTranslations('customers.list')
  const label = customerListLabel(customer)
  const contact = [customer.email, customer.phone].filter(
    (value): value is string => value !== null && value !== label
  )
  return (
    <Button
      variant="ghost"
      className="h-auto w-full flex-col items-start gap-0 px-2 py-1.5 text-left"
      onClick={() => onPick(customer.id)}
    >
      <span className="max-w-full truncate font-medium">{label ?? t('unnamed')}</span>
      {contact.length === 0 ? null : (
        <span className="text-muted-foreground max-w-full truncate text-xs font-normal">
          {contact.join(' · ')}
        </span>
      )}
    </Button>
  )
}

function Merge({
  survivorId,
  absorbedId,
  step,
  merge,
  picks,
  onPick,
  onStep,
  onDone
}: {
  survivorId: string
  absorbedId: string
  step: Step
  merge: CustomerMerges['merge']
  picks: Picks
  onPick: (field: MergeableField, source: MergeFieldSource) => void
  onStep: (step: Step) => void
  onDone: () => void
}): ReactElement {
  const t = useTranslations('customers.merge')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const preview = useMergePreview(storeId, survivorId, absorbedId)
  const [typed, setTyped] = useState('')

  if (preview.isPending) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {tAll('common.loading')}
      </p>
    )
  }
  if (preview.isError) {
    return (
      <div className="flex flex-col gap-3">
        <MutationError error={preview.error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onStep('pick')}>
            {t('back')}
          </Button>
        </DialogFooter>
      </div>
    )
  }

  const conflicts = knownConflicts(preview.data.conflicts)
  const word = t('confirmWord')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!phraseMatches(typed, word)) return
    merge.mutate(
      { absorbedId, fieldChoices: fieldChoicesOf(conflicts, picks) },
      { onSuccess: onDone }
    )
  }

  if (step === 'confirm') {
    return (
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm">
          {t('confirmIntro', { name: sideName(preview.data.absorbed, t('unnamed')) })}
        </p>
        <div className="flex flex-col gap-1">
          <Label htmlFor="merge-confirm">{t('confirmLabel', { word })}</Label>
          <Input
            id="merge-confirm"
            autoFocus
            autoComplete="off"
            value={typed}
            onChange={event => setTyped(event.target.value)}
          />
        </div>
        <MutationError error={merge.error} />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={merge.isPending}
            onClick={() => onStep('review')}
          >
            {t('back')}
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={merge.isPending || !phraseMatches(typed, word)}
          >
            {t('confirm')}
          </Button>
        </DialogFooter>
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Summary preview={preview.data} />
      {conflicts.length === 0 ? null : (
        <Conflicts preview={preview.data} conflicts={conflicts} picks={picks} onPick={onPick} />
      )}
      <DialogFooter>
        <Button variant="outline" onClick={() => onStep('pick')}>
          {t('back')}
        </Button>
        <Button onClick={() => onStep('confirm')}>{t('continue')}</Button>
      </DialogFooter>
    </div>
  )
}

function sideName(side: CustomerMergePreviewView['survivor'], unnamed: string): string {
  return side.name ?? side.email ?? side.phone ?? unnamed
}

const COUNTED = ['conversations', 'notes', 'addresses', 'tags', 'identities'] as const

function Summary({ preview }: { preview: CustomerMergePreviewView }): ReactElement {
  const t = useTranslations('customers.merge')
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        {t('summary', {
          survivor: sideName(preview.survivor, t('unnamed')),
          absorbed: sideName(preview.absorbed, t('unnamed'))
        })}
      </p>
      <dl className="flex flex-col gap-1 text-sm">
        {COUNTED.map(key => {
          const count = preview.counts[key]
          return (
            <div key={key} className="flex justify-between gap-4">
              <dt>{t(`counts.${key}`)}</dt>
              <dd className="text-muted-foreground">
                {key === 'tags'
                  ? t('countUnion', {
                      survivor: count.survivor,
                      absorbed: count.absorbed,
                      merged: count.merged
                    })
                  : t('countSum', {
                      survivor: count.survivor,
                      absorbed: count.absorbed,
                      merged: count.merged
                    })}
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}

function Conflicts({
  preview,
  conflicts,
  picks,
  onPick
}: {
  preview: CustomerMergePreviewView
  conflicts: MergeableField[]
  picks: Picks
  onPick: (field: MergeableField, source: MergeFieldSource) => void
}): ReactElement {
  const t = useTranslations('customers.merge')
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">{t('conflictsTitle')}</p>
      {conflicts.map(field => (
        <fieldset key={field} className="flex flex-col gap-1">
          <legend className="text-muted-foreground mb-1 text-xs font-semibold uppercase">
            {t(`fields.${field}`)}
          </legend>
          {[MergeFieldSources.SURVIVOR, MergeFieldSources.ABSORBED].map(source => {
            const side = source === MergeFieldSources.SURVIVOR ? preview.survivor : preview.absorbed
            return (
              <label key={source} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`merge-${field}`}
                  checked={(picks[field] ?? MergeFieldSources.SURVIVOR) === source}
                  onChange={() => onPick(field, source)}
                />
                <span className="break-all">{side[field]}</span>
              </label>
            )
          })}
        </fieldset>
      ))}
    </div>
  )
}
