'use client'

import { Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import {
  type FormEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'

import type { FinanceTaxRateView, PurchaseOrderView } from '@platform/api-client'
import { TaxRounding } from '@platform/core/domain'

import { moneyText, percentOfBps } from '../../lib/finance/money'
import {
  centsOfText,
  type LineDraft,
  type LineField,
  lineDraftOf,
  lineInputsOf,
  linesProblem,
  moneyOfLines,
  wholeOfText
} from '../../lib/finance/purchase-form'
import { usePurchaseErrorText } from '../../lib/finance/use-purchase-error-text'
import { useUpdatePurchaseOrder } from '../../lib/finance/use-purchases'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { type PickedItem, PurchaseItemPicker } from './purchase-item-picker'

// The lines of a draft order: what is bought, how many and at what cost of one unit before tax (TDD_18 §2.7). They are saved whole (the
// api replaces the list), so what is on screen is what gets sent. `taxRates` and `rounding` are null for who cannot read the chart: the
// tax of a line is then not shown (the api still computes it when the goods arrive).
export function OrderLinesEditor({
  order,
  labels,
  taxRates,
  rounding,
  onDirty
}: {
  order: PurchaseOrderView
  labels: ReadonlyMap<string, string>
  taxRates: readonly FinanceTaxRateView[] | null
  rounding: TaxRounding | null
  // Whether the lines on screen differ from the saved ones: the page does not mark the order as ordered over unsaved edits
  onDirty: (dirty: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.purchases.lines')
  const locale = useLocale()
  const errorText = usePurchaseErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const update = useUpdatePurchaseOrder(storeId)
  const [lines, setLines] = useState<LineDraft[]>(() =>
    order.lines.map(line => lineDraftOf(line, labels.get(line.id) ?? line.productId.slice(0, 8)))
  )
  const [wrong, setWrong] = useState<{ index: number; field: LineField } | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const counter = useRef(0)

  const rateOf = useMemo(
    () => new Map((taxRates ?? []).map(rate => [rate.id, rate.rateBps])),
    [taxRates]
  )
  const changed = useMemo(() => {
    const saved = order.lines.map(line => ({
      productId: line.productId,
      variantId: line.variantId ?? '',
      quantity: String(line.quantity),
      cost: line.unitCostCents,
      taxRateId: line.taxRateId ?? ''
    }))
    const now = lines.map(line => ({
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity.trim(),
      cost: centsOfText(line.unitCost),
      taxRateId: line.taxRateId
    }))
    return JSON.stringify(saved) !== JSON.stringify(now)
  }, [lines, order.lines])

  useEffect(() => {
    onDirty(changed)
    return () => onDirty(false)
  }, [changed, onDirty])

  const money = useMemo(() => {
    const valid = lines.flatMap(line => {
      const quantity = wholeOfText(line.quantity)
      const cost = centsOfText(line.unitCost)
      return quantity === null || cost === null
        ? []
        : [
            {
              quantity,
              unitCostCents: cost,
              taxRateId: line.taxRateId === '' ? null : line.taxRateId
            }
          ]
    })
    // The tax needs the chart; without it only the subtotal is shown
    return moneyOfLines(valid, id => rateOf.get(id) ?? null, rounding ?? TaxRounding.HALF_UP)
  }, [lines, rateOf, rounding])
  const taxKnown = taxRates !== null && rounding !== null

  const edit = (apply: (current: LineDraft[]) => LineDraft[]): void => {
    setLines(apply)
    setWrong(null)
    setRefusal(null)
  }
  const patch = (key: string, change: Partial<LineDraft>): void =>
    edit(current => current.map(line => (line.key === key ? { ...line, ...change } : line)))

  const add = (item: PickedItem): void => {
    counter.current += 1
    const key = `new-${String(counter.current)}`
    edit(current => [
      ...current,
      {
        key,
        productId: item.productId,
        variantId: item.variantId ?? '',
        label: item.label,
        quantity: '1',
        unitCost: '',
        taxRateId: ''
      }
    ])
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = linesProblem(lines)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    if (!changed || !guard.enter()) return
    update.mutate(
      { id: order.id, changes: { lines: lineInputsOf(lines) } },
      {
        onSuccess: () => toast.success(t('saved')),
        onError: error => setRefusal(errorText(error)),
        onSettled: guard.leave
      }
    )
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <PurchaseItemPicker onPick={add} />
      {lines.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="order-lines-draft">
          {lines.map((line, index) => {
            const problem = wrong?.index === index ? wrong.field : null
            return (
              <li
                key={line.key}
                data-testid="order-line-draft"
                className="flex flex-col gap-2 rounded-md border p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium">{labels.get(line.key) ?? line.label}</span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('remove', { name: labels.get(line.key) ?? line.label })}
                    onClick={() => edit(current => current.filter(item => item.key !== line.key))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <LineBox
                    label={t('quantity')}
                    value={line.quantity}
                    inputMode="numeric"
                    problem={problem === 'quantity' ? t('wrongQuantity') : null}
                    onChange={quantity => patch(line.key, { quantity })}
                  />
                  <LineBox
                    label={t('unitCost')}
                    value={line.unitCost}
                    inputMode="decimal"
                    problem={problem === 'unitCost' ? t('wrongCost') : null}
                    onChange={unitCost => patch(line.key, { unitCost })}
                  />
                  {taxRates === null ? null : (
                    <LineSelect
                      label={t('taxRate')}
                      value={line.taxRateId}
                      onChange={taxRateId => patch(line.key, { taxRateId })}
                    >
                      <option value="">{t('noTax')}</option>
                      {taxRates
                        .filter(rate => rate.active || rate.id === line.taxRateId)
                        .map(rate => (
                          <option key={rate.id} value={rate.id}>
                            {rate.name} · {percentOfBps(rate.rateBps)} %
                          </option>
                        ))}
                    </LineSelect>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <dl className="grid grid-cols-3 gap-3 text-sm" data-testid="order-lines-totals">
        <Total label={t('subtotal')} value={moneyText(locale, money.subtotalCents)} />
        <Total
          label={t('tax')}
          value={taxKnown ? moneyText(locale, money.taxCents) : t('taxUnknown')}
        />
        <Total
          label={t('total')}
          value={taxKnown ? moneyText(locale, money.totalCents) : t('taxUnknown')}
          strong
        />
      </dl>
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={update.isPending || !changed}>
          {t('save')}
        </Button>
      </div>
    </form>
  )
}

function LineBox({
  label,
  value,
  inputMode,
  problem,
  onChange
}: {
  label: string
  value: string
  inputMode: 'numeric' | 'decimal'
  problem: string | null
  onChange: (value: string) => void
}): ReactElement {
  const id = `${label}-${useId()}`
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        inputMode={inputMode}
        aria-invalid={problem !== null}
        onChange={event => onChange(event.target.value)}
      />
      {problem === null ? null : (
        <p role="alert" className="text-destructive text-xs">
          {problem}
        </p>
      )}
    </div>
  )
}

function LineSelect({
  label,
  value,
  onChange,
  children
}: {
  label: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
}): ReactElement {
  const id = `${label}-${useId()}`
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className={SELECT_CLASS}
        value={value}
        onChange={event => onChange(event.target.value)}
      >
        {children}
      </select>
    </div>
  )
}

function Total({
  label,
  value,
  strong = false
}: {
  label: string
  value: string
  strong?: boolean
}): ReactElement {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={strong ? 'font-semibold tabular-nums' : 'tabular-nums'}>{value}</dd>
    </div>
  )
}
