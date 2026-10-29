'use client'

import { TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { StatusScreen } from '../components/shared/status-screen'
import { Button } from '../components/ui/button'

export default function ErrorPage({ reset }: { reset: () => void }): ReactElement {
  const t = useTranslations()
  return (
    <StatusScreen icon={TriangleAlert} title={t('errorPage.title')} body={t('errorPage.body')}>
      <Button onClick={reset}>{t('common.tryAgain')}</Button>
    </StatusScreen>
  )
}
