import type { StorePreferences } from '@platform/core/store-preferences'

// What a plugin reads of the store preferences, key by key (an allowlist: a key the preferences gain tomorrow stays out until
// somebody decides a plugin may read it). Left out on purpose: the discount limit and the price-override notice, which are
// approval controls of the owner and say how far a member may go without an approver.
export interface PluginPreferencesView {
  sendReadReceipts: boolean
  assignOnReply: boolean
  orders: Pick<
    StorePreferences['orders'],
    | 'confirmOnCreate'
    | 'sendSummaryOnCreate'
    | 'freeShippingRule'
    | 'failedAttemptMessages'
    | 'cancellationReasons'
  >
  returns: StorePreferences['returns']
  remittances: StorePreferences['remittances']
}

export function pluginPreferencesView(preferences: StorePreferences): PluginPreferencesView {
  const { orders, returns, remittances } = preferences
  return {
    sendReadReceipts: preferences.sendReadReceipts,
    assignOnReply: preferences.assignOnReply,
    orders: {
      confirmOnCreate: orders.confirmOnCreate,
      sendSummaryOnCreate: orders.sendSummaryOnCreate,
      freeShippingRule: orders.freeShippingRule,
      failedAttemptMessages: orders.failedAttemptMessages,
      cancellationReasons: orders.cancellationReasons
    },
    returns: { preselectCautionOnRefusal: returns.preselectCautionOnRefusal },
    remittances: { overdueAfterDays: remittances.overdueAfterDays }
  }
}
