import { SearchX } from 'lucide-react'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import type { ReactElement } from 'react'

import { AppPaths } from '@platform/api-client'

import { StatusScreen } from '../components/shared/status-screen'
import { buttonVariants } from '../components/ui/button'

export default async function NotFound(): Promise<ReactElement> {
  const t = await getTranslations()
  return (
    <StatusScreen icon={SearchX} title={t('notFound.title')} body={t('notFound.body')}>
      <Link href={AppPaths.login} className={buttonVariants()}>
        {t('common.backToStart')}
      </Link>
    </StatusScreen>
  )
}
