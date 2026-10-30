'use client'

import { MessageSquare } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { InboxState } from './inbox-state'

export function SelectConversation(): ReactElement {
  const t = useTranslations('inbox.select')
  return <InboxState icon={MessageSquare} heading="h1" title={t('title')} body={t('body')} />
}
