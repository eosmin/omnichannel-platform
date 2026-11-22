'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useCallback, useEffect, useId, useRef, useState } from 'react'

import { recordCookieConsent } from '@platform/api-client'
import {
  ChoosableCookieCategories,
  type ChoosableCookieCategory,
  COOKIE_PREFERENCES_OPEN_EVENT,
  CookieCategories
} from '@platform/core/cookie-consent'

import { apiClient } from '../../lib/api'
import {
  ALL_ALLOWED,
  type CookieChoice,
  currentChoice,
  NONE_ALLOWED,
  newChoice,
  parseStoredChoice,
  writeChoice
} from '../../lib/cookie-consent/cookie-choice'
import { toast } from '../../lib/toast'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

export interface CookieConsentUiProps {
  openPanelOnMount: boolean
}

type Categories = Record<ChoosableCookieCategory, boolean>

const sameAnswer = (a: CookieChoice, b: CookieChoice): boolean =>
  a.visitorId === b.visitorId &&
  a.policyVersion === b.policyVersion &&
  ChoosableCookieCategories.every(category => a.categories[category] === b.categories[category])

// The banner and the panel of preferences. The banner does not cover the page for good and does not trap the focus: the app works
// whatever the person answers, and nothing optional is switched on until they allow it. The answer is written to the cookie first
// (the browser keeps it whatever the network does) and then sent to the api; one the api did not get is sent again on a later page.
export default function CookieConsentUi({ openPanelOnMount }: CookieConsentUiProps): ReactElement {
  const t = useTranslations('cookieConsent')
  const titleId = useId()
  const [choice, setChoice] = useState<CookieChoice | null>(null)
  const [read, setRead] = useState(false)
  const [panelOpen, setPanelOpen] = useState(openPanelOnMount)
  const [draft, setDraft] = useState<Categories>(NONE_ALLOWED)
  const sending = useRef(false)

  // One request at a time. What the cookie holds when a request ends is what rules: an answer given while a request was in flight
  // is sent next, and a request that ended for an answer that is no longer the one in the cookie never marks the newer one as sent.
  const send = useCallback(
    async (toSend: CookieChoice, announce: boolean): Promise<void> => {
      if (sending.current) return
      sending.current = true
      let next: CookieChoice | null = null
      try {
        await recordCookieConsent(apiClient, {
          visitorId: toSend.visitorId,
          categories: toSend.categories
        })
        const now = parseStoredChoice(document.cookie)
        if (now !== null && sameAnswer(now, toSend)) {
          const settled = { ...toSend, synced: true }
          writeChoice(settled)
          setChoice(settled)
          if (announce) toast.success(t('saved'))
        } else if (now !== null && !now.synced) {
          next = now
        }
      } catch {
        if (announce) toast.info(t('syncFailed'))
      } finally {
        sending.current = false
      }
      if (next !== null) await send(next, announce)
    },
    [t]
  )

  useEffect(() => {
    const stored = currentChoice(document.cookie)
    setChoice(stored)
    setRead(true)
    // A choice the api does not have yet: sent again, quietly
    if (stored !== null && !stored.synced) void send(stored, false)
  }, [send])

  useEffect(() => {
    const onOpen = (): void => setPanelOpen(true)
    window.addEventListener(COOKIE_PREFERENCES_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(COOKIE_PREFERENCES_OPEN_EVENT, onOpen)
  }, [])

  // The panel shows what is saved, or everything off when nothing was answered
  useEffect(() => {
    if (panelOpen) setDraft(currentChoice(document.cookie)?.categories ?? NONE_ALLOWED)
  }, [panelOpen])

  const answer = (categories: Categories): void => {
    const next = newChoice(categories, parseStoredChoice(document.cookie))
    writeChoice(next)
    setChoice(next)
    setPanelOpen(false)
    void send(next, true)
  }

  return (
    <>
      {read && choice === null ? (
        <section
          aria-labelledby={titleId}
          className="bg-background fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-2xl flex-col gap-3 rounded-lg border p-4 shadow-lg"
        >
          <h2 id={titleId} className="text-base font-semibold">
            {t('bannerTitle')}
          </h2>
          <p className="text-muted-foreground text-sm">{t('bannerBody')}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => setPanelOpen(true)}>
              {t('customize')}
            </Button>
            <Button variant="outline" onClick={() => answer(NONE_ALLOWED)}>
              {t('reject')}
            </Button>
            <Button variant="outline" onClick={() => answer(ALL_ALLOWED)}>
              {t('accept')}
            </Button>
          </div>
        </section>
      ) : null}
      <Dialog open={panelOpen} onOpenChange={setPanelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('panelTitle')}</DialogTitle>
            <DialogDescription>{t('panelDescription')}</DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-4">
            <CategoryRow
              category={CookieCategories.NECESSARY}
              checked
              disabled
              label={t('categories.necessary.label')}
              description={t('categories.necessary.description')}
            />
            {ChoosableCookieCategories.map(category => (
              <CategoryRow
                key={category}
                category={category}
                checked={draft[category]}
                label={t(`categories.${category}.label`)}
                description={t(`categories.${category}.description`)}
                onChange={checked => setDraft(current => ({ ...current, [category]: checked }))}
              />
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => answer(NONE_ALLOWED)}>
              {t('reject')}
            </Button>
            <Button variant="outline" onClick={() => answer(ALL_ALLOWED)}>
              {t('accept')}
            </Button>
            <Button onClick={() => answer(draft)}>{t('save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function CategoryRow({
  category,
  checked,
  disabled = false,
  label,
  description,
  onChange
}: {
  category: string
  checked: boolean
  disabled?: boolean
  label: string
  description: string
  onChange?: (checked: boolean) => void
}): ReactElement {
  const id = useId()
  return (
    <li className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        data-category={category}
        className="mt-1 size-4 pointer-coarse:size-5"
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-description`}
        onChange={event => onChange?.(event.target.checked)}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-description`} className="text-muted-foreground text-sm">
          {description}
        </p>
      </div>
    </li>
  )
}
