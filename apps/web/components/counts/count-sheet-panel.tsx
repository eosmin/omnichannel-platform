'use client'

import { CloudOff, Search, TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type KeyboardEvent, type ReactElement, useMemo, useRef, useState } from 'react'

import type { CountLineView } from '@platform/api-client'

import { parseCountedQuantity } from '../../lib/counts/count-quantity'
import {
  type CountEdits,
  countedOf,
  exactSkuMatches,
  progressOf,
  type SheetFilter,
  SheetFilters,
  visibleLines
} from '../../lib/counts/count-sheet'
import { type CountSaver, SaverStates } from '../../lib/counts/use-count-saver'
import { useErrorText } from '../../lib/use-error-text'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

// How many cards are drawn at first and each time "show more" is pressed: a sheet holds up to 2 000 lines
const CARDS_PER_STEP = 50
const INPUT_ATTRIBUTE = 'data-count-input'

// The sheet a person counts on, from a phone in the aisle (TDD_16 §7): one big card per item, a numeric keyboard, a
// search that a scanner can type into, and the progress always in view. The quantity the warehouse should hold is NOT
// shown here: a count that starts from the expected number tends to confirm it. The review shows it.
export function CountSheetPanel({
  lines,
  saver,
  canCount
}: {
  lines: readonly CountLineView[]
  saver: CountSaver
  canCount: boolean
}): ReactElement {
  const t = useTranslations('counts.sheet')
  const [filter, setFilter] = useState<SheetFilter>(SheetFilters.ALL)
  const [term, setTerm] = useState('')
  const [shown, setShown] = useState(CARDS_PER_STEP)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // Which cards are listed is decided by what was counted when the person last left a field, not by every key: a card
  // that left the "not counted" list at its first digit would take the focus with it and lose the rest of the number
  const [settled, setSettled] = useState<CountEdits>(saver.edits)
  const visible = useMemo(
    () => visibleLines(lines, settled, filter, term),
    [lines, settled, filter, term]
  )
  const progress = useMemo(() => progressOf(lines, saver.edits), [lines, saver.edits])
  const percent = progress.total === 0 ? 0 : Math.round((progress.counted / progress.total) * 100)

  const inputs = (): HTMLInputElement[] =>
    Array.from(
      listRef.current?.querySelectorAll<HTMLInputElement>(`input[${INPUT_ATTRIBUTE}]`) ?? []
    )

  // A scanner types the code and presses Enter: the line of that sku takes the focus, ready for its quantity
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const matches = exactSkuMatches(visible, term)
    // Only a code that is a sku, or a search that has narrowed the list to one card: never the first of several
    const first = matches[0] ?? (visible.length === 1 ? visible[0] : undefined)
    if (first === undefined) return
    const target = listRef.current?.querySelector<HTMLInputElement>(
      `input[${INPUT_ATTRIBUTE}="${CSS.escape(first.id)}"]`
    )
    target?.focus()
    target?.select()
  }

  // Enter in a quantity goes on: back to the search when there is a code to scan next, else to the next card
  const onQuantityKey = (event: KeyboardEvent<HTMLInputElement>, lineId: string): void => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (term.trim() !== '') {
      setTerm('')
      searchRef.current?.focus()
      return
    }
    const all = inputs()
    const index = all.findIndex(input => input.getAttribute(INPUT_ATTRIBUTE) === lineId)
    const next = all[index + 1]
    if (next === undefined) return
    next.focus()
    next.select()
  }

  return (
    <section aria-label={t('label')} className="flex flex-col gap-3">
      <div className="bg-background sticky top-0 z-10 flex flex-col gap-2 border-b py-2">
        <div className="flex items-center justify-between gap-2 text-sm">
          <p role="status" aria-live="polite">
            {t('progress', { counted: progress.counted, total: progress.total })}
          </p>
          <SaveStatus saver={saver} />
        </div>
        <div
          role="progressbar"
          aria-label={t('progressLabel')}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.counted}
          className="bg-muted h-2 overflow-hidden rounded-full"
        >
          <div className="bg-primary h-full" style={{ width: `${percent}%` }} />
        </div>
        <div className="relative">
          <Search
            aria-hidden
            className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <Input
            ref={searchRef}
            type="search"
            inputMode="search"
            enterKeyHint="go"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label={t('search')}
            placeholder={t('searchPlaceholder')}
            value={term}
            className="pl-9"
            onChange={event => {
              setTerm(event.target.value)
              setSettled(saver.edits)
              setShown(CARDS_PER_STEP)
            }}
            onKeyDown={onSearchKey}
          />
        </div>
        <div role="group" aria-label={t('filterLabel')} className="flex gap-2">
          {Object.values(SheetFilters).map(value => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? 'default' : 'outline'}
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value)
                setSettled(saver.edits)
                setShown(CARDS_PER_STEP)
              }}
            >
              {t(`filters.${value}`)}
            </Button>
          ))}
        </div>
      </div>
      {visible.length === 0 ? (
        <p role="status" className="text-muted-foreground py-6 text-center text-sm">
          {term.trim() !== ''
            ? t('noMatch')
            : filter === SheetFilters.UNCOUNTED
              ? t('allCounted')
              : t('noLines')}
        </p>
      ) : (
        <ul
          ref={listRef}
          className="flex flex-col gap-2"
          onBlurCapture={() => setSettled(saver.edits)}
        >
          {visible.slice(0, shown).map(line => (
            <CountCard
              key={line.id}
              line={line}
              counted={countedOf(line, saver.edits)}
              disabled={!canCount}
              onChange={saver.setQuantity}
              onKeyDown={onQuantityKey}
            />
          ))}
        </ul>
      )}
      {visible.length > shown ? (
        <Button variant="outline" onClick={() => setShown(current => current + CARDS_PER_STEP)}>
          {t('showMore', { count: visible.length - shown })}
        </Button>
      ) : null}
      <p className="text-muted-foreground text-sm">{t('missingItem')}</p>
    </section>
  )
}

function CountCard({
  line,
  counted,
  disabled,
  onChange,
  onKeyDown
}: {
  line: CountLineView
  counted: number | null
  disabled: boolean
  onChange: (lineId: string, quantity: number | null) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>, lineId: string) => void
}): ReactElement {
  const t = useTranslations('counts.sheet')
  // What is in the field while it is being typed: a half-typed value is not a quantity yet
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? (counted === null ? '' : String(counted))
  const parsed = parseCountedQuantity(shown)
  const invalid = parsed.kind === 'invalid'
  const label = [line.productName, line.variantName].filter(Boolean).join(' · ')
  const errorId = `count-error-${line.id}`

  return (
    <li
      className={cn(
        'flex items-center justify-between gap-3 rounded-lg border p-3',
        counted !== null && !invalid && 'border-primary/40 bg-primary/5'
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium break-words">{line.productName}</span>
        {line.variantName !== null ? (
          <span className="text-muted-foreground text-sm break-words">{line.variantName}</span>
        ) : null}
        {line.sku !== null ? (
          <span className="text-muted-foreground font-mono text-xs break-all">{line.sku}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Input
          {...{ [INPUT_ATTRIBUTE]: line.id }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          enterKeyHint="next"
          autoComplete="off"
          aria-label={t('quantityOf', { name: label })}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          disabled={disabled}
          value={shown}
          placeholder={t('quantityPlaceholder')}
          className="h-14 w-28 text-center text-2xl font-semibold tabular-nums pointer-coarse:h-14"
          onFocus={event => event.target.select()}
          onChange={event => {
            const next = event.target.value
            setText(next)
            const result = parseCountedQuantity(next)
            if (result.kind === 'ok') onChange(line.id, result.value)
            else if (result.kind === 'empty') onChange(line.id, null)
          }}
          onBlur={() => setText(null)}
          onKeyDown={event => onKeyDown(event, line.id)}
        />
        {invalid ? (
          <p id={errorId} role="alert" className="text-destructive text-xs">
            {t('invalidQuantity')}
          </p>
        ) : null}
      </div>
    </li>
  )
}

// Whether what was typed is safe: saved, on its way, kept on the phone for want of a signal, or refused
function SaveStatus({ saver }: { saver: CountSaver }): ReactElement {
  const t = useTranslations('counts.sheet.save')
  const errorText = useErrorText()
  const pending = Object.keys(saver.edits).length
  if (saver.state === SaverStates.REFUSED) {
    return (
      <p role="alert" className="text-destructive flex items-center gap-1">
        <TriangleAlert aria-hidden className="size-4" />
        <span>{saver.error === null ? t('refused') : errorText(saver.error)}</span>
      </p>
    )
  }
  if (saver.state === SaverStates.OFFLINE) {
    return (
      <p role="status" className="text-muted-foreground flex items-center gap-1">
        <CloudOff aria-hidden className="size-4" />
        <span>{t('offline', { count: pending })}</span>
      </p>
    )
  }
  return (
    <p role="status" className="text-muted-foreground">
      {saver.state === SaverStates.SAVED ? t('saved') : t('saving', { count: pending })}
    </p>
  )
}
