import type { ReactElement } from 'react'

import { NotificationPreferencesPage } from '../notification-preferences-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('accountNotifications')

export default function Page(): ReactElement {
  return <NotificationPreferencesPage />
}
