import { ShieldOff } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import type { ReactElement } from 'react'

import { StatusScreen } from '../../components/shared/status-screen'

export default async function NoAccessPage(): Promise<ReactElement> {
  const t = await getTranslations('noAccess')
  return <StatusScreen icon={ShieldOff} title={t('title')} body={t('body')} />
}
