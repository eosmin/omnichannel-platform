import { UserX } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

// The small mark of a customer whose personal data was erased (TDD_05 §10.3): the profile, the list of the inbox and the
// header of the conversation draw it, so nobody takes the placeholder name for a person.
export function ErasedChip(): ReactElement {
  const t = useTranslations('customers.erasure')
  return (
    <span className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium">
      <UserX aria-hidden className="size-3" />
      {t('chip')}
    </span>
  )
}
