// The purchase rules are pure and a screen uses them too, so they live in the domain lib; this file keeps the old path of the services.
export {
  billBalances,
  canTransition,
  documentNumberKey,
  dueDay,
  needsUncreditableTaxAccount,
  paymentLines,
  paymentProblems,
  PaymentRule,
  PurchaseRule,
  receiptEntryLines,
  receiptMoney,
  receiptProblems,
  statusAfterReceipt
} from '@platform/core/domain'
export type {
  BillBalance,
  BillFacts,
  PaymentRuleName,
  PurchaseRuleName,
  ReceiptEntryAccounts,
  ReceiptEntryLine,
  ReceiptLineInput,
  ReceiptLineMoney,
  ReceiptMoney
} from '@platform/core/domain'
