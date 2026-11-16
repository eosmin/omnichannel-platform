import type { ReactElement } from 'react'

import { pageTitle } from '../../lib/page-titles'

import { FinanceHome } from './finance-shell'

export const generateMetadata = pageTitle('finance')

export default function FinancePage(): ReactElement {
  return <FinanceHome />
}
