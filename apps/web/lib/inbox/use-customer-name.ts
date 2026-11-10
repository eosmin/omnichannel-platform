'use client'

import { useTranslations } from 'next-intl'

import type { ConversationListItemView } from '@platform/api-client'

import { customerLabelOf, type CustomerLabel } from './customer-label'

// A customer nobody names whose channel declares them anonymous (a visitor of a site) is a "Visitante"; the
// customer of any other channel with no name is a "Cliente" (the channel says where they come from, and the
// visitor word would be wrong). The flag comes from the conversation, read from the view in the cache.
function unnamedLabel(
  t: ReturnType<typeof useTranslations<'inbox'>>,
  anonymous: boolean,
  digits: string
): string {
  return t(anonymous ? 'anonymousCustomer' : 'unnamedCustomer', {
    digits
  })
}

// The name the list and the header give a customer, in one place so that they never disagree
export function useCustomerName(
  customer: ConversationListItemView['customer'],
  anonymous: boolean
): {
  label: CustomerLabel
  name: string
} {
  const t = useTranslations('inbox')
  const label = customerLabelOf(customer)
  const name = label.kind === 'identity' ? unnamedLabel(t, anonymous, label.lastDigits) : label.text
  return { label, name }
}

// The same name for a customer who is not on screen as a row of its own (the toast of an action)
export function useCustomerNamer(): (
  customer: ConversationListItemView['customer'],
  anonymous: boolean
) => string {
  const t = useTranslations('inbox')
  return (customer, anonymous) => {
    const label = customerLabelOf(customer)
    return label.kind === 'identity' ? unnamedLabel(t, anonymous, label.lastDigits) : label.text
  }
}
