'use client'

import { Copy, Mail, Phone, UserRound } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { MessageView } from '@platform/api-client'

import { toast } from '../../lib/toast'
import { Button } from '../ui/button'

const KNOWN_KINDS = ['CELL', 'MAIN', 'IPHONE', 'HOME', 'WORK'] as const
type KnownKind = (typeof KNOWN_KINDS)[number]

function knownKind(kind: string): KnownKind | null {
  const upper = kind.trim().toUpperCase()
  return KNOWN_KINDS.find(known => known === upper) ?? null
}

// One value of a contact with its label and a button that puts it on the clipboard. The text is the
// customer's (or of whoever they copied it from): drawn as plain text, never as a link.
function Value({
  icon: Icon,
  value,
  kind
}: {
  icon: typeof Phone
  value: string
  kind: string | undefined
}): ReactElement {
  const t = useTranslations('inbox.thread.contacts')
  // The channel names the kind of a phone or an email from a short list; one it does not know is drawn as it came
  const label =
    kind === undefined
      ? undefined
      : knownKind(kind) === null
        ? kind
        : t(`kind.${knownKind(kind) ?? 'HOME'}`)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(t('copied'))
    } catch {
      // The clipboard is refused on a page without permission: the value is still on screen to select
      toast.error(t('copyFailed'))
    }
  }
  return (
    <li className="flex items-center gap-1.5">
      <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">
        {label === undefined ? null : (
          <span className="text-muted-foreground text-xs">{label} </span>
        )}
        {value}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label={t('copyAria', { value: label === undefined ? value : `${label} ${value}` })}
        onClick={() => void copy()}
      >
        <Copy aria-hidden />
      </Button>
    </li>
  )
}

// The contacts a customer shared: for each, the name, the phones and the emails, each with a button to copy
// it. The server cleaned and bounded them; this only draws.
export function ContactCard({
  contacts
}: {
  contacts: NonNullable<MessageView['contacts']>
}): ReactElement {
  const t = useTranslations('inbox.thread.contacts')
  return (
    <ul
      role="list"
      aria-label={t('list')}
      className="flex w-[min(280px,100%)] flex-col gap-2 overflow-hidden"
    >
      {contacts.map((contact, index) => (
        <li key={index} className="flex flex-col gap-1">
          <p className="flex items-start gap-1.5 overflow-hidden font-medium">
            <UserRound aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 break-words">{contact.name}</span>
          </p>
          {contact.phones.length === 0 && contact.emails.length === 0 ? null : (
            <ul role="list" aria-label={contact.name} className="flex flex-col gap-0.5 pl-5">
              {contact.phones.map((phone, at) => (
                <Value key={`p${at}`} icon={Phone} value={phone.number} kind={phone.kind} />
              ))}
              {contact.emails.map((email, at) => (
                <Value key={`e${at}`} icon={Mail} value={email.address} kind={email.kind} />
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}
