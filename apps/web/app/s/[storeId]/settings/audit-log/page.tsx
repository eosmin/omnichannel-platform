import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreAuditLogPage } from '../audit-log-page'

export const generateMetadata = pageTitle('settingsAuditLog')

export default function Page(): ReactElement {
  return <StoreAuditLogPage />
}
