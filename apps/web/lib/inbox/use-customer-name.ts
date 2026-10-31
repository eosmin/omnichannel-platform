'use client'

import { useTranslations } from 'next-intl'

import type { ConversationListItemView } from '@platform/api-client'

import { customerLabelOf, type CustomerLabel } from './customer-label'

// The name the list and the header give a customer, in one place so that they never disagree
export function useCustomerName(
  customer: ConversationListItemView['customer'],
  channelName: string
): { label: CustomerLabel; name: string } {
  const t = useTranslations('inbox')
  const label = customerLabelOf(customer)
  const name =
    label.kind === 'identity'
      ? t('customerOnChannel', { channel: channelName, digits: label.lastDigits })
      : label.text
  return { label, name }
}

// The same name for a customer who is not on screen as a row of its own (the toast of an action)
export function useCustomerNamer(): (
  customer: ConversationListItemView['customer'],
  channelName: string
) => string {
  const t = useTranslations('inbox')
  return (customer, channelName) => {
    const label = customerLabelOf(customer)
    return label.kind === 'identity'
      ? t('customerOnChannel', { channel: channelName, digits: label.lastDigits })
      : label.text
  }
}
