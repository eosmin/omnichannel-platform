import type { ReactElement } from 'react'

import { NoAccessScreen } from '../../components/shell/no-access-screen'
import { pageTitle } from '../../lib/page-titles'

export const generateMetadata = pageTitle('noAccess')

export default function NoAccessPage(): ReactElement {
  return <NoAccessScreen />
}
