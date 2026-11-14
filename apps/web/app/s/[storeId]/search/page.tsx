import type { ReactElement } from 'react'

import { SearchPage } from '../../search-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('search')

export default function Page(): ReactElement {
  return <SearchPage />
}
