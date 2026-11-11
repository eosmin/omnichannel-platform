import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { TransferDetailPage } from '../../transfer-detail-page'

export const generateMetadata = pageTitle('orgTransfer')

export default function OrgTransferPage(): ReactElement {
  return <TransferDetailPage />
}
