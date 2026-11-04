'use client'

import { useTranslations } from 'next-intl'

import type { ConversationListItemView } from '@platform/api-client'
import { ChannelIds } from '@platform/core/domain'

import { customerLabelOf, type CustomerLabel } from './customer-label'

// A web widget visitor who gave no name is a "Visitante"; the customer of any other channel with no
// name is a "Cliente" (the channel says where they come from, and the visitor word would be wrong)
function unnamedLabel(
  t: ReturnType<typeof useTranslations<'inbox'>>,
  channelType: string,
  digits: string
): string {
  return t(channelType === ChannelIds.WEB_WIDGET ? 'anonymousCustomer' : 'unnamedCustomer', {
    digits
  })
}

// The name the list and the header give a customer, in one place so that they never disagree
export function useCustomerName(
  customer: ConversationListItemView['customer'],
  channelType: string
): {
  label: CustomerLabel
  name: string
} {
  const t = useTranslations('inbox')
  const label = customerLabelOf(customer)
  const name =
    label.kind === 'identity' ? unnamedLabel(t, channelType, label.lastDigits) : label.text
  return { label, name }
}

// The same name for a customer who is not on screen as a row of its own (the toast of an action)
export function useCustomerNamer(): (
  customer: ConversationListItemView['customer'],
  channelType: string
) => string {
  const t = useTranslations('inbox')
  return (customer, channelType) => {
    const label = customerLabelOf(customer)
    return label.kind === 'identity' ? unnamedLabel(t, channelType, label.lastDigits) : label.text
  }
}
