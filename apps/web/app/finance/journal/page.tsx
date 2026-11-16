import type { ReactElement } from 'react'

import { JournalPage } from '../journal-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('financeJournal')

export default function FinanceJournalPageRoute(): ReactElement {
  return <JournalPage />
}
