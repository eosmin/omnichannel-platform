import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { TransfersPage } from '../transfers-page'

export const generateMetadata = pageTitle('orgTransfers')

export default function OrgTransfersPage(): ReactElement {
  return <TransfersPage />
}
