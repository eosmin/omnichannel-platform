import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { FinanceSettingsPage } from '../settings-page'

export const generateMetadata = pageTitle('financeSettings')

export default function FinanceFinanceSettingsPageRoute(): ReactElement {
  return <FinanceSettingsPage />
}
