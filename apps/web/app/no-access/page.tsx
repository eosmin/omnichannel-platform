import { ShieldOff } from 'lucide-react'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import type { ReactElement } from 'react'

import { SignOutButton } from '../../components/auth/sign-out-button'
import { StatusScreen } from '../../components/shared/status-screen'
import { Button } from '../../components/ui/button'

export default async function NoAccessPage(): Promise<ReactElement> {
  const t = await getTranslations('noAccess')
  return (
    <StatusScreen icon={ShieldOff} title={t('title')} body={t('body')}>
      <Button asChild>
        <Link href="/">{t('checkAgain')}</Link>
      </Button>
      <SignOutButton />
    </StatusScreen>
  )
}
