import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { ReturnsReceptionPage } from '../pages'

export const generateMetadata = pageTitle('returns')

export default function Page(): ReactElement {
  return <ReturnsReceptionPage />
}
