import type { ReactElement } from 'react'

import { StorePickupsPage } from '../../store-pickups-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('pickups')

export default function Page(): ReactElement {
  return <StorePickupsPage />
}
