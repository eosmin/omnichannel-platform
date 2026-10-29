import { redirect } from 'next/navigation'

import { AppPaths } from '@platform/api-client'

export default function AccountPage(): never {
  redirect(AppPaths.account.profile)
}
