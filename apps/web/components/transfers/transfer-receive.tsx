'use client'

import { Minus, Plus, ScanLine } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  useId,
  useRef,
  useState
} from 'react'

import type { TransferLineView, TransferView } from '@platform/api-client'

import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import {
  addOneUnit,
  allPendingOf,
  linesMatching,
  lineOfCode,
  parseQuantity,
  type ReceiptEntries,
  receiptOf
} from '../../lib/transfers/transfer-form'
import { useReceiveTransfer } from '../../lib/transfers/use-transfers'
import { useErrorText } from '../../lib/use-error-text'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// Receiving a transfer on a phone, at the door of the warehouse (TDD_16 §4.5, TDD_09 §16): one big card per line with
// what is pending against what arrived, a box for the units that are in the hands now, a button that adds one unit
// (the scanner of the phone types the SKU into the search box and presses Enter), and one button that takes in all
// that is pending. Receiving can be partial and be done many times; the receipt key makes a double tap count once.
export function TransferReceive({
  transfer,
  storeId
}: {
  transfer: TransferView
  storeId: string
}): ReactElement {
  const t = useTranslations('transfers.receive')
  const errorText = useErrorText()
  const guard = useSubmitGuard()
  const receive = useReceiveTransfer(storeId, transfer.id)
  const ids = useId()
  const [entries, setEntries] = useState<ReceiptEntries>({})
  const [code, setCode] = useState('')
  const [scanned, setScanned] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  // The code names a line that has already arrived in full
  const [complete, setComplete] = useState(false)
  const [wrongLineId, setWrongLineId] = useState<string | null>(null)
  const [empty, setEmpty] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  // One key per attempt: a retry of the same receipt replays, and any change of what is received makes a new one
  const receiptKey = useRef<string>(crypto.randomUUID())

  const change = (next: ReceiptEntries): void => {
    receiptKey.current = crypto.randomUUID()
    setEntries(next)
    setWrongLineId(null)
    setEmpty(false)
    setRefusal(null)
  }

  const pending = transfer.lines.filter(line => line.pendingQuantity > 0)
  const shown = linesMatching(transfer.lines, code)

  const scan = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const line = lineOfCode(transfer.lines, code)
    if (line === null) {
      setNotFound(true)
      setComplete(false)
      setScanned(null)
      return
    }
    if (line.pendingQuantity === 0) {
      setNotFound(false)
      setComplete(true)
      setScanned(null)
      return
    }
    setNotFound(false)
    setComplete(false)
    setScanned(line.id)
    change(addOneUnit(line, entries))
    setCode('')
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const receipt = receiptOf(transfer.lines, entries)
    if (!receipt.ok) {
      setWrongLineId(receipt.wrongLineId)
      setEmpty(receipt.wrongLineId === null)
      return
    }
    if (!guard.enter()) return
    receive.mutate(
      { receiptKey: receiptKey.current, lines: receipt.lines },
      {
        onSuccess: () => {
          toast.success(t('done'))
          change({})
          setScanned(null)
        },
        onError: error => setRefusal(errorText(error)),
        onSettled: guard.leave
      }
    )
  }

  if (pending.length === 0)
    return <p className="text-muted-foreground text-sm">{t('nothingPending')}</p>

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-code`}>{t('code')}</Label>
        <div className="relative">
          <ScanLine
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <Input
            id={`${ids}-code`}
            className="h-12 pl-9 text-base"
            value={code}
            autoComplete="off"
            autoCapitalize="characters"
            enterKeyHint="done"
            onChange={event => {
              setCode(event.target.value)
              setNotFound(false)
              setComplete(false)
            }}
            onKeyDown={scan}
          />
        </div>
        <p className="text-muted-foreground text-xs">{t('codeHint')}</p>
        {notFound ? (
          <p role="alert" className="text-destructive text-sm">
            {t('notInTransfer')}
          </p>
        ) : null}
        {complete ? (
          <p role="alert" className="text-destructive text-sm">
            {t('alreadyComplete')}
          </p>
        ) : null}
        <p role="status" className="sr-only">
          {scanned === null ? '' : t('scanned', { name: nameOf(transfer.lines, scanned) })}
        </p>
      </div>

      <Button
        type="button"
        variant="outline"
        className="h-12 text-base"
        onClick={() => change(allPendingOf(transfer.lines))}
      >
        {t('all')}
      </Button>

      <ul className="flex flex-col gap-3">
        {shown.map(line => (
          <ReceiveCard
            key={line.id}
            line={line}
            value={entries[line.id] ?? ''}
            wrong={wrongLineId === line.id}
            highlighted={scanned === line.id}
            onChange={text => change({ ...entries, [line.id]: text })}
            onAdd={() => change(addOneUnit(line, entries))}
            onTakeOne={() => change(takeOne(line, entries))}
          />
        ))}
      </ul>
      {shown.length === 0 ? <p className="text-muted-foreground text-sm">{t('noMatch')}</p> : null}

      {empty ? (
        <p role="alert" className="text-destructive text-sm">
          {t('nothingEntered')}
        </p>
      ) : null}
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="bg-background sticky bottom-0 -mx-1 border-t px-1 py-3">
        <Button type="submit" className="h-12 w-full text-base" busy={receive.isPending}>
          {t('submit')}
        </Button>
      </div>
    </form>
  )
}

const nameOf = (lines: readonly TransferLineView[], id: string): string => {
  const line = lines.find(item => item.id === id)
  if (line === undefined) return ''
  return line.variantName === null ? line.productName : `${line.productName} · ${line.variantName}`
}

// One unit less, down to none
function takeOne(line: TransferLineView, entries: ReceiptEntries): ReceiptEntries {
  const current = parseQuantity(entries[line.id] ?? '') ?? 0
  const next = Math.max(current - 1, 0)
  return { ...entries, [line.id]: String(next) }
}

function ReceiveCard({
  line,
  value,
  wrong,
  highlighted,
  onChange,
  onAdd,
  onTakeOne
}: {
  line: TransferLineView
  value: string
  wrong: boolean
  highlighted: boolean
  onChange: (text: string) => void
  onAdd: () => void
  onTakeOne: () => void
}): ReactElement {
  const t = useTranslations('transfers.receive')
  const id = useId()
  const name =
    line.variantName === null ? line.productName : `${line.productName} · ${line.variantName}`
  const done = line.pendingQuantity === 0
  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-lg border p-4',
        highlighted && 'border-primary ring-primary/30 ring-2',
        done && 'bg-muted/40'
      )}
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-base font-medium">{name}</span>
        {line.sku === null ? null : (
          <span className="text-muted-foreground text-sm">{line.sku}</span>
        )}
      </div>
      <dl className="grid grid-cols-3 gap-2 text-center">
        <Figure label={t('sent')} value={line.quantity} />
        <Figure label={t('received')} value={line.receivedQuantity} />
        <Figure label={t('pending')} value={line.pendingQuantity} strong />
      </dl>
      {done ? (
        <p className="text-muted-foreground text-sm">{t('complete')}</p>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-12"
            aria-label={t('lessOf', { name })}
            onClick={onTakeOne}
          >
            <Minus aria-hidden />
          </Button>
          <Label htmlFor={id} className="sr-only">
            {t('unitsOf', { name })}
          </Label>
          <Input
            id={id}
            inputMode="numeric"
            className="h-12 flex-1 text-center text-lg"
            placeholder="0"
            value={value}
            aria-invalid={wrong}
            aria-describedby={wrong ? `${id}-error` : undefined}
            onChange={event => onChange(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-12"
            aria-label={t('moreOf', { name })}
            onClick={onAdd}
          >
            <Plus aria-hidden />
          </Button>
        </div>
      )}
      {wrong ? (
        <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
          {t('wrongUnits', { max: line.pendingQuantity })}
        </p>
      ) : null}
    </li>
  )
}

function Figure({
  label,
  value,
  strong = false
}: {
  label: string
  value: number
  strong?: boolean
}): ReactElement {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={cn('text-xl tabular-nums', strong && 'font-semibold')}>{value}</dd>
    </div>
  )
}
