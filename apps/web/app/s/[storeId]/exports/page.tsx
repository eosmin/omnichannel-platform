import type { ReactElement } from 'react'

import { ExportsPage } from '../../exports-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('exports')

export default function Page(): ReactElement {
  return <ExportsPage />
}
