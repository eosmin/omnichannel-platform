'use client'

import { Plus, TriangleAlert, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useRef, useState } from 'react'

import { AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import {
  OrderLimits,
  OrderNotices,
  PaymentMethod,
  PriceApprovalStatus
} from '@platform/core/domain'

import { useCustomer } from '../../lib/customers/use-customer-data'
import {
  DiscountHints,
  discountHint,
  estimatedSubtotalCents
} from '../../lib/orders/order-approval'
import { type CopySeed, copySeedOf, copyWarningRows } from '../../lib/orders/order-copy'
import {
  buildOrder,
  canAddPhone,
  type DraftForm,
  emptyForm,
  type FormField,
  initialPhones,
  phoneDigits,
  shippingAddressOf,
  type StockRules
} from '../../lib/orders/order-form'
import {
  useConversationCustomerId,
  useCreateOrder,
  useOrderCopy,
  useOrderPreferences
} from '../../lib/orders/use-create-order'
import { useStockOfLines } from '../../lib/orders/use-line-stock'
import { formatCents } from '../../lib/products/money'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet'
import { Textarea } from '../ui/textarea'

import { OrderCustomerField } from './order-customer-field'
import { OrderLinesSection } from './order-lines-section'
import { OrderPriceFields } from './order-price-fields'

// The create-order drawer (TDD_09 §5): a panel at the right with the order, so the conversation it comes from stays
// beside it. It sends what the agent chose and never a total: the server prices the order from the catalog.
export function CreateOrderDrawer({
  customerId,
  conversationId,
  copyOfOrderId,
  isOpen,
  onClose
}: {
  customerId: string | undefined
  conversationId: string | undefined
  copyOfOrderId?: string | undefined
  isOpen: boolean
  onClose: () => void
}): ReactElement {
  const t = useTranslations('orders.create')
  const [isBusy, setBusy] = useState(false)
  return (
    // Not closed while the order is being saved: the answer, a refusal included, must reach the agent
    <Sheet
      open={isOpen}
      onOpenChange={open => {
        if (!open && !isBusy) onClose()
      }}
    >
      <SheetContent
        className="md:w-[520px] md:max-w-[90vw]"
        // A click on the dimmed page (the thread beside the drawer) must not throw away what was typed
        onInteractOutside={event => event.preventDefault()}
      >
        <SheetHeader>
          <SheetTitle>{t('title')}</SheetTitle>
          <SheetDescription>{t('description')}</SheetDescription>
        </SheetHeader>
        <Start
          customerId={customerId}
          conversationId={conversationId}
          copyOfOrderId={copyOfOrderId}
          onBusy={setBusy}
          onClose={onClose}
        />
      </SheetContent>
    </Sheet>
  )
}

// An empty form, or the draft of an order that is copied: the form starts from it once it is read, so it is not drawn before
function Start({
  copyOfOrderId,
  ...rest
}: {
  customerId: string | undefined
  conversationId: string | undefined
  copyOfOrderId: string | undefined
  onBusy: (busy: boolean) => void
  onClose: () => void
}): ReactElement {
  const tAll = useTranslations()
  const t = useTranslations('orders.copy')
  const { storeId } = useStore()
  const copy = useOrderCopy(storeId, copyOfOrderId)
  if (copyOfOrderId === undefined) return <Body {...rest} seed={null} warnings={[]} />
  // A failed background read must not throw away a form that is already filled
  if (copy.isError && copy.data === undefined) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
        <p>{t('failed')}</p>
        <MutationError error={copy.error} />
        <Button type="button" variant="outline" size="sm" onClick={() => void copy.refetch()}>
          {tAll('common.tryAgain')}
        </Button>
      </div>
    )
  }
  if (copy.data === undefined) {
    return (
      <p role="status" className="text-muted-foreground p-4 text-sm">
        {tAll('common.loading')}
      </p>
    )
  }
  return <Body {...rest} seed={copySeedOf(copy.data)} warnings={copyWarningRows(copy.data)} />
}

interface Wrong {
  field: FormField
  line?: string | undefined
}

function Body({
  customerId: initialCustomerId,
  conversationId,
  seed,
  warnings,
  onBusy,
  onClose
}: {
  customerId: string | undefined
  conversationId: string | undefined
  seed: CopySeed | null
  warnings: ReturnType<typeof copyWarningRows>
  onBusy: (busy: boolean) => void
  onClose: () => void
}): ReactElement {
  const t = useTranslations('orders.create')
  const tPhones = useTranslations('orders.create.phones')
  const tNotes = useTranslations('orders.create.notes')
  const tAll = useTranslations()
  const router = useRouter()
  const { storeId, can } = useStore()
  const guard = useSubmitGuard()
  const create = useCreateOrder(storeId, {
    onSuccess: ({ order, notices }) => {
      const number = tAll('orders.list.number', { number: order.orderNumber })
      const isHeld = order.priceApprovalStatus === (PriceApprovalStatus.PENDING as string)
      toast.success(t(isHeld ? 'createdAwaitingApproval' : 'created', { number }), {
        action: {
          label: t('open'),
          onClick: () => router.push(AppPaths.store.order(storeId, order.id))
        }
      })
      if (notices.includes(OrderNotices.CONFIRMATION_SKIPPED_PRICE_APPROVAL)) {
        toast.info(t('confirmationSkipped'))
      }
      onClose()
    },
    onSettled: () => {
      guard.leave()
      onBusy(false)
    }
  })

  const canOverridePrice = can(ClientPermissions.ORDERS_OVERRIDE_PRICE)
  const canConfirm = can(ClientPermissions.ORDERS_CONFIRM)
  const mayViewCustomers = can(ClientPermissions.CUSTOMERS_VIEW)

  // The two checkboxes start from the preferences of the store; what the agent chooses wins over them. A member who cannot
  // read the preferences sees no summary box (the server follows the preference) and a confirm box that starts unchecked.
  const { preferences, isSettled } = useOrderPreferences(
    storeId,
    can(ClientPermissions.SETTINGS_VIEW)
  )
  const [confirmChoice, setConfirmChoice] = useState<boolean | null>(null)
  const [summaryChoice, setSummaryChoice] = useState<boolean | null>(null)
  // The start is latched the first time the preferences are known: a read again must not flip a box the agent has seen
  const latched = useRef(preferences)
  if (latched.current === null && preferences !== null) latched.current = preferences
  const confirmChecked = confirmChoice ?? latched.current?.confirmOnCreate ?? false
  const summaryChecked = summaryChoice ?? latched.current?.sendSummaryOnCreate ?? false

  const [form, setForm] = useState<DraftForm>(() =>
    seed === null
      ? { ...emptyForm(), customerId: initialCustomerId ?? null }
      : {
          ...emptyForm(),
          customerId: seed.customerId,
          lines: seed.lines,
          shippingText: seed.shippingText,
          paymentMethod: seed.paymentMethod,
          phones: seed.phones,
          customerNotes: seed.customerNotes,
          internalNotes: seed.internalNotes,
          packingNotes: seed.packingNotes
        }
  )
  // The phones of a copy are the ones the order had: the customer's own phone does not replace them
  // What came from the copied order stays only while the order is for the same customer
  const isSameCustomer = seed !== null && form.customerId === seed.customerId
  const copiedAddress = isSameCustomer ? seed.shippingAddress : undefined
  const [wrong, setWrong] = useState<Wrong | null>(null)
  const [phonesTouched, setPhonesTouched] = useState(
    seed !== null && seed.phones.some(phone => phone !== '')
  )
  const patch = (changes: Partial<DraftForm>): void => {
    setForm(current => ({ ...current, ...changes }))
    setWrong(null)
    create.reset()
  }

  // "Change customer" must not bring the conversation's one back
  const customerCleared = useRef(false)
  // The customer of the conversation, until the agent picks another one
  const fromConversation = useConversationCustomerId(storeId, conversationId)
  useEffect(() => {
    if (
      fromConversation.customerId !== null &&
      form.customerId === null &&
      !customerCleared.current
    ) {
      setForm(current => ({ ...current, customerId: fromConversation.customerId }))
    }
  }, [fromConversation.customerId, form.customerId])

  const customer = useCustomer(storeId, mayViewCustomers ? form.customerId : null)
  // Pre-fill the recipient phones from the customer once, unless the agent already wrote there
  const prefilled = useRef<string | null>(null)
  useEffect(() => {
    const data = customer.data
    // A copy from the cache that is being read again is not trusted: the phone may have changed since
    if (
      data === undefined ||
      customer.isFetching ||
      phonesTouched ||
      prefilled.current === data.id
    ) {
      return
    }
    prefilled.current = data.id
    setForm(current => ({ ...current, phones: initialPhones(data.nationalPhone) }))
  }, [customer.data, customer.isFetching, phonesTouched])

  const stockOf = useStockOfLines(form.lines)

  const addresses = customer.data?.addresses ?? []

  const submit = (): void => {
    const stock = new Map<string, StockRules>()
    for (const line of form.lines) {
      const rules = stockOf(line).rules
      if (rules !== null) stock.set(line.key, rules)
    }
    const result = buildOrder(
      { ...form, confirmOnCreate: confirmChecked },
      { canOverridePrice, canConfirm },
      {
        ...(conversationId === undefined ? {} : { conversationId }),
        ...(seed === null || !isSameCustomer ? {} : { copiedFromOrderId: seed.copiedFromOrderId }),
        // Fail closed: with no box to ask, no message goes to the customer that the agent did not ask for
        sendSummary: preferences === null ? false : summaryChecked,
        stock
      }
    )
    if (!result.ok) return setWrong({ field: result.field, line: result.line })
    const address = addresses.find(row => row.id === form.addressId)
    // The address of the order it was copied from stays unless the agent picks another one
    const body =
      address !== undefined
        ? { ...result.value, shippingAddress: shippingAddressOf(address) }
        : copiedAddress === undefined
          ? result.value
          : { ...result.value, shippingAddress: copiedAddress }
    if (!guard.enter()) return
    onBusy(true)
    create.mutate(body)
  }

  const fieldError = (field: FormField): ReactElement | null =>
    wrong?.field === field ? (
      <p id={`order-${field}-error`} role="alert" className="text-destructive text-sm">
        {t(`errors.${field}`)}
      </p>
    ) : null
  const invalid = (field: FormField) =>
    wrong?.field === field
      ? { 'aria-invalid': true, 'aria-describedby': `order-${field}-error` }
      : {}

  const customerId = form.customerId
  const tCopy = useTranslations('orders.copy')
  const tHint = useTranslations('orders.create.discountHint')
  const hint = discountHint({
    discountText: form.discountText,
    subtotalCents: estimatedSubtotalCents(form.lines, canOverridePrice),
    canOverridePrice,
    limitPercent: preferences?.discountLimitPercent ?? null
  })
  const format = useFormatter()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain p-4">
        {seed === null ? null : (
          <section
            aria-labelledby="order-copy-heading"
            className="flex flex-col gap-1 rounded-md border p-3 text-sm"
          >
            <h3 id="order-copy-heading" className="font-medium">
              {tCopy('heading')}
            </h3>
            <p className="text-muted-foreground">{tCopy('help')}</p>
            {warnings.length === 0 ? null : (
              <ul className="mt-1 flex flex-col gap-1">
                {warnings.map((row, index) => (
                  <li key={index} className="flex items-start gap-1.5">
                    <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
                    <span>
                      {tCopy(`warnings.${row.code ?? 'unknown'}`, {
                        name:
                          row.variantName === null
                            ? row.productName
                            : `${row.productName} (${row.variantName})`,
                        previous: formatCents(format, row.previousCents ?? 0),
                        current: formatCents(format, row.currentCents ?? 0)
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {customer.data?.isCaution === true ? (
          <div
            role="note"
            className="flex items-start gap-2 rounded-md border border-amber-500/60 bg-amber-50 p-3 text-sm dark:bg-amber-950/30"
          >
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <p>
              <span className="font-medium">{t('cautionBanner.title')}</span>
              {customer.data.cautionReason === null ? null : ` ${customer.data.cautionReason}`}
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <OrderCustomerField
            customerId={customerId}
            customer={customer.data}
            fallbackLabel={
              fromConversation.customerId === form.customerId ? fromConversation.label : null
            }
            isLoading={customerId !== null && customer.isPending && mayViewCustomers}
            onChoose={id => {
              if (id === null) customerCleared.current = true
              prefilled.current = null
              setPhonesTouched(false)
              patch({ customerId: id, addressId: null, phones: [''] })
            }}
          />
          {fieldError('customer')}
          {fromConversation.isFailed ? (
            <p role="alert" className="text-destructive text-sm">
              {t('customer.conversationFailed')}
            </p>
          ) : null}
        </div>

        <OrderLinesSection
          lines={form.lines}
          onLines={lines => patch({ lines })}
          canOverridePrice={canOverridePrice}
          stockOf={stockOf}
          wrong={wrong}
        />

        <OrderPriceFields
          values={form}
          onChange={changes => patch(changes)}
          wrong={wrong?.field ?? null}
        />
        {hint === DiscountHints.NONE || hint === DiscountHints.UNKNOWN ? null : (
          <p
            role="status"
            className={
              hint === DiscountHints.NEEDS_APPROVAL
                ? 'rounded-md border border-amber-500/60 bg-amber-50 p-2 text-sm dark:bg-amber-950/30'
                : 'text-muted-foreground text-xs'
            }
          >
            {tHint(hint, { limit: preferences?.discountLimitPercent ?? 0 })}
          </p>
        )}

        <div className="flex flex-col gap-1">
          <Label htmlFor="order-scheduled-date">{t('delivery.scheduledDate')}</Label>
          <Input
            id="order-scheduled-date"
            type="date"
            value={form.scheduledDate}
            onChange={event => patch({ scheduledDate: event.target.value })}
            {...invalid('scheduledDate')}
          />
          <p className="text-muted-foreground text-xs">{t('delivery.scheduledHelp')}</p>
          {fieldError('scheduledDate')}
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{tPhones('label')}</legend>
          <p className="text-muted-foreground text-xs">{tPhones('help')}</p>
          {form.phones.map((phone, index) => (
            // The position is the identity of a phone in this list: they have no id until they are saved
            <div key={index} className="flex items-center gap-2">
              <Label htmlFor={`order-phone-${index}`} className="sr-only">
                {tPhones('field', { index: index + 1 })}
              </Label>
              <Input
                id={`order-phone-${index}`}
                type="tel"
                inputMode="numeric"
                autoComplete="off"
                value={phone}
                onChange={event => {
                  setPhonesTouched(true)
                  patch({
                    phones: form.phones.map((row, at) => (at === index ? event.target.value : row))
                  })
                }}
                // Digits only on leaving the field: what is stored is what the carrier receives
                onBlur={() =>
                  patch({
                    phones: form.phones.map((row, at) => (at === index ? phoneDigits(row) : row))
                  })
                }
                {...invalid('phones')}
              />
              {form.phones.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={tPhones('remove', { index: index + 1 })}
                  onClick={() => {
                    setPhonesTouched(true)
                    patch({ phones: form.phones.filter((_, at) => at !== index) })
                  }}
                >
                  <X aria-hidden />
                </Button>
              ) : null}
            </div>
          ))}
          {canAddPhone(form.phones) ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => {
                setPhonesTouched(true)
                patch({ phones: [...form.phones, ''] })
              }}
            >
              <Plus aria-hidden />
              {tPhones('add')}
            </Button>
          ) : null}
          {fieldError('phones')}
        </fieldset>

        {addresses.length > 0 ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="order-address">{t('address.label')}</Label>
            <select
              id="order-address"
              className={SELECT_CLASS}
              value={form.addressId ?? ''}
              onChange={event => patch({ addressId: event.target.value || null })}
            >
              <option value="">
                {copiedAddress === undefined
                  ? t('address.none')
                  : t('address.copied', { line1: copiedAddress.line1, city: copiedAddress.city })}
              </option>
              {addresses.map(address => (
                <option key={address.id} value={address.id}>
                  {t('address.option', { line1: address.line1, city: address.city })}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <Label htmlFor="order-payment">{t('payment.label')}</Label>
          <select
            id="order-payment"
            className={SELECT_CLASS}
            value={form.paymentMethod}
            onChange={event => patch({ paymentMethod: event.target.value as PaymentMethod })}
          >
            {Object.values(PaymentMethod).map(method => (
              <option key={method} value={method}>
                {tAll(`orders.paymentMethod.${method}`)}
              </option>
            ))}
          </select>
        </div>

        <section className="flex flex-col gap-4">
          <NoteField
            id="order-customer-notes"
            label={tNotes('customer')}
            help={tNotes('customerHelp')}
            maxLength={OrderLimits.CUSTOMER_NOTES_MAX_LENGTH}
            value={form.customerNotes}
            onChange={value => patch({ customerNotes: value })}
          />
          <NoteField
            id="order-internal-notes"
            label={tNotes('internal')}
            help={tNotes('internalHelp')}
            maxLength={OrderLimits.INTERNAL_NOTES_MAX_LENGTH}
            value={form.internalNotes}
            onChange={value => patch({ internalNotes: value })}
          />
          <NoteField
            id="order-packing-notes"
            label={tNotes('packing')}
            help={tNotes('packingHelp')}
            maxLength={OrderLimits.PACKING_NOTES_MAX_LENGTH}
            value={form.packingNotes}
            onChange={value => patch({ packingNotes: value })}
            // The amber band of the packing screens (Steps 4.10 and 4.14) starts here
            className="border-amber-500/60 bg-amber-50 dark:bg-amber-950/30"
          />
        </section>

        {canConfirm ? (
          <div className="flex items-start gap-2">
            <input
              id="order-confirm"
              type="checkbox"
              className="mt-1"
              checked={confirmChecked}
              disabled={!isSettled}
              onChange={event => setConfirmChoice(event.target.checked)}
            />
            <div className="flex flex-col">
              <Label htmlFor="order-confirm">{t('confirm.label')}</Label>
              <span className="text-muted-foreground text-xs">{t('confirm.help')}</span>
            </div>
          </div>
        ) : null}
        {preferences === null ? null : (
          <div className="flex items-start gap-2">
            <input
              id="order-send-summary"
              type="checkbox"
              className="mt-1"
              checked={summaryChecked}
              onChange={event => setSummaryChoice(event.target.checked)}
            />
            <div className="flex flex-col">
              <Label htmlFor="order-send-summary">{t('sendSummary.label')}</Label>
              <span className="text-muted-foreground text-xs">{t('sendSummary.help')}</span>
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2 border-t p-4">
        <MutationError error={create.error} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            busy={create.isPending}
            disabled={create.isPending || !isSettled}
            onClick={submit}
          >
            {t('submit')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function NoteField({
  id,
  label,
  help,
  maxLength,
  value,
  onChange,
  className
}: {
  id: string
  label: string
  help: string
  maxLength: number
  value: string
  onChange: (value: string) => void
  className?: string
}): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        rows={2}
        maxLength={maxLength}
        aria-describedby={`${id}-help`}
        value={value}
        onChange={event => onChange(event.target.value)}
        className={className}
      />
      <p id={`${id}-help`} className="text-muted-foreground text-xs">
        {help}
      </p>
    </div>
  )
}
