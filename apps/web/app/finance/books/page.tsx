import type { ReactElement } from 'react'

import { BooksPage } from '../books-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('financeBooks')

export default function FinanceBooksPageRoute(): ReactElement {
  return <BooksPage />
}
