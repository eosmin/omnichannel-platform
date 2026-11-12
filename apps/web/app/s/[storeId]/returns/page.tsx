import type { ReactElement } from 'react'

import { ReturnsPage } from '../../returns-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('returns')

export default function Page(): ReactElement {
  return <ReturnsPage />
}
