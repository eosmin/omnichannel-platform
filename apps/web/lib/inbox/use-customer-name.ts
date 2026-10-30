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
