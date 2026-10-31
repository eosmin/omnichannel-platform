'use client'

import { MoreHorizontal, Pencil, Plus, X } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useState } from 'react'

import type { CustomerDetailView } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'

import { conversationCount } from '../../lib/customers/conversation-count'
import { customerDisplayName, initialsOfName } from '../../lib/customers/customer-name'
import { tagDotColor } from '../../lib/customers/tag-color'
import {
  useCustomerConversations,
  useCustomerIdentityEdits
} from '../../lib/customers/use-customer-data'
import { useChannelName } from '../../lib/inbox/use-inbox-data'
import { CustomerAvatar } from '../inbox/customer-avatar'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

import { AddressEditor } from './address-editor'
import { MutationError } from './mutation-error'
import { ProfileForm } from './profile-form'
import { TagEditor } from './tag-editor'

// The merge dialog and the link form load when they are first opened: the panel of the inbox draws
// this component, and the inbox has a script budget (apps/web-e2e/lighthouse/budgets.ts)
const MergeDialog = dynamic(() => import('./merge-dialog').then(module => module.MergeDialog), {
  ssr: false
})
const IdentityLinkForm = dynamic(
  () => import('./identity-link-form').then(module => module.IdentityLinkForm),
  { ssr: false }
)

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function IdentityRow({
  identity,
  customerId,
  editable
}: {
  identity: CustomerDetailView['identities'][number]
  customerId: string
  editable: boolean
}): ReactElement {
  const t = useTranslations('customers.identity')
  const { storeId } = useStore()
  const channelName = useChannelName(storeId, identity.channelType)
  const { unlink } = useCustomerIdentityEdits(storeId, customerId)
  const handle = identity.displayName ?? identity.channelIdentity
  return (
    <li className="flex flex-col text-sm">
      <div className="flex items-center gap-2">
        <span className="flex-1 font-medium">{channelName}</span>
        {editable ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            aria-label={t('unlink', { channel: channelName, handle })}
            disabled={unlink.isPending}
            onClick={() => unlink.mutate(identity.id)}
          >
            <X />
          </Button>
        ) : null}
      </div>
      <span className="text-muted-foreground break-all">{handle}</span>
      <MutationError error={unlink.error} />
    </li>
  )
}

// The count of conversations. The profile has no order figures until Step 4.4, so the stats are
// "customer since" and this count.
function ConversationsStat({ customerId }: { customerId: string }): ReactElement | null {
  const t = useTranslations('customers.profile')
  const tCommon = useTranslations('common')
  const { storeId, can } = useStore()
  const mayRead = can(Permissions.CONVERSATIONS_VIEW)
  const conversations = useCustomerConversations(storeId, customerId, mayRead)
  if (!mayRead) return null
  if (conversations.data === undefined) {
    return (
      <div className="flex justify-between text-sm">
        <dt>{t('stats.conversations')}</dt>
        <dd className="text-muted-foreground">
          {conversations.isError ? t('stats.failed') : tCommon('loading')}
        </dd>
      </div>
    )
  }
  const { count, isExact } = conversationCount(conversations.data)
  return (
    <div className="flex justify-between text-sm">
      <dt>{t('stats.conversations')}</dt>
      <dd>{isExact ? count : t('stats.atLeast', { count })}</dd>
    </div>
  )
}

// The identity side of the profile (TDD_09 §6), used by the drawer and by the panel of the inbox:
// who the customer is, the channels they write from, the figures, the tags and the addresses. With
// `editable` (the drawer) whoever holds CUSTOMERS_EDIT can change the contact data, the tags and the
// addresses; the panel of the inbox only reads.
export function CustomerDetails({
  customer,
  editable = false
}: {
  customer: CustomerDetailView
  editable?: boolean
}): ReactElement {
  const t = useTranslations('customers.profile')
  const tEdit = useTranslations('customers.edit')
  const tIdentity = useTranslations('customers.identity')
  const { can } = useStore()
  const mayEdit = editable && can(Permissions.CUSTOMERS_EDIT)
  const tMerge = useTranslations('customers.merge')
  const mayMerge = editable && can(Permissions.CUSTOMERS_MERGE)
  const [isEditing, setEditing] = useState(false)
  const [isLinking, setLinking] = useState(false)
  // `absorbedId` is set by "Merge instead", which skips the search for the duplicate
  const [merge, setMerge] = useState<{ absorbedId?: string } | null>(null)
  const format = useFormatter()
  const name = customerDisplayName(customer)
  const since = new Date(customer.createdAt)
  const contact = [customer.email, customer.phone].filter(
    (value): value is string => value !== null && value !== name
  )

  return (
    <div className="flex flex-col gap-4">
      {isEditing ? (
        // Keyed by the customer: a refetch while the agent types must not wipe the form
        <ProfileForm key={customer.id} customer={customer} onDone={() => setEditing(false)} />
      ) : (
        <div className="flex items-center gap-3">
          <CustomerAvatar avatarUrl={null} initials={initialsOfName(name)} />
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="truncate font-semibold">{name ?? t('unnamed')}</p>
            {contact.map(line => (
              <p key={line} className="text-muted-foreground truncate text-xs">
                {line}
              </p>
            ))}
          </div>
          {mayEdit ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={tEdit('editProfile')}
              onClick={() => setEditing(true)}
            >
              <Pencil />
            </Button>
          ) : null}
          {mayMerge ? (
            // Not modal: a modal menu leaves the page locked when it hands over to the merge dialog
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label={tMerge('moreActions')}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setMerge({})}>{tMerge('open')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      )}
      {customer.isCaution ? (
        <p role="note" className="bg-muted rounded-md p-2 text-sm">
          <span className="font-medium">{t('caution')}</span>
          {customer.cautionReason === null ? null : ` ${customer.cautionReason}`}
        </p>
      ) : null}

      <Section title={t('identities')}>
        {customer.identities.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noIdentities')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {customer.identities.map(identity => (
              <IdentityRow
                key={identity.id}
                identity={identity}
                customerId={customer.id}
                editable={mayEdit}
              />
            ))}
          </ul>
        )}
        {mayEdit ? (
          isLinking ? (
            <IdentityLinkForm
              customerId={customer.id}
              onDone={() => setLinking(false)}
              onMergeInstead={ownerId => {
                setLinking(false)
                setMerge({ absorbedId: ownerId })
              }}
            />
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => setLinking(true)}
            >
              <Plus />
              {tIdentity('add')}
            </Button>
          )
        ) : null}
      </Section>

      <Section title={t('stats.title')}>
        <dl className="flex flex-col gap-1">
          <ConversationsStat customerId={customer.id} />
          <div className="flex justify-between text-sm">
            <dt>{t('stats.since')}</dt>
            <dd>
              {Number.isNaN(since.getTime())
                ? t('stats.unknown')
                : format.dateTime(since, { month: 'short', year: 'numeric' })}
            </dd>
          </div>
        </dl>
      </Section>

      <Section title={t('tags')}>
        {mayEdit ? (
          <TagEditor customer={customer} />
        ) : customer.tags.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noTags')}</p>
        ) : (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {customer.tags.map(tag => (
              <li key={tag.id} className="flex items-center gap-1">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: tagDotColor(tag.color) }}
                />
                {tag.name}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {merge === null ? null : (
        <MergeDialog
          survivorId={customer.id}
          absorbedId={merge.absorbedId}
          onClose={() => setMerge(null)}
        />
      )}

      <Section title={t('addresses', { count: customer.addresses.length })}>
        {mayEdit ? (
          <AddressEditor customer={customer} />
        ) : customer.addresses.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noAddresses')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {customer.addresses.map(address => (
              <li key={address.id} className="text-sm">
                {address.label === null && !address.isDefault ? null : (
                  <p className="font-medium">
                    {[address.label, address.isDefault ? t('defaultAddress') : null]
                      .filter(part => part !== null)
                      .join(' · ')}
                  </p>
                )}
                <p className="text-muted-foreground">
                  {[
                    address.line1,
                    address.line2,
                    address.city,
                    address.state,
                    address.postalCode,
                    address.country
                  ]
                    .filter((part): part is string => part !== null && part !== '')
                    .join(', ')}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
