import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreWebhooksPage } from '../webhooks-page'

export const generateMetadata = pageTitle('settingsWebhooks')

export default function Page(): ReactElement {
  return <StoreWebhooksPage />
}
