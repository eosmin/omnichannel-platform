import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { ReturnDetailPage } from '../pages'

export const generateMetadata = pageTitle('returns')

export default function Page(): ReactElement {
  return <ReturnDetailPage />
}
