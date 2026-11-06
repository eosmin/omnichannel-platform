'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useId, useRef, useState } from 'react'

import { ApiError } from '@platform/api-client'
import { ChannelIds, MetaOAuth } from '@platform/core/domain'
import { ChannelConnectFailureReasons } from '@platform/core/errors'

import type { OAuthAssetView } from '../../lib/settings/channels-requests'
import { connectFailureReasonOf } from '../../lib/settings/connect-failure'
import { missingPermissionsOf } from '../../lib/settings/oauth-return'
import { dropOAuthSession, useCompleteOAuth, useOAuthAssets } from '../../lib/settings/use-channels'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { ConnectError } from './connect-error'

// What is painted of the name of a Page or of an Instagram account: text, cut. It comes from Meta.
const MAX_SHOWN = 80
// By characters and not by code units: a name with emoji must not be cut in the middle of one
const cut = (value: string): string => {
  const characters = Array.from(value)
  return characters.length > MAX_SHOWN ? `${characters.slice(0, MAX_SHOWN).join('')}…` : value
}

// The Pages of a login that Facebook sent the person back from (Step 7.8): the person picks one, and that is
// what is connected. The session behind it holds their token on the server and is dropped if they leave
// without finishing.
export function OAuthAssetDialog({
  sessionId,
  onClose
}: {
  sessionId: string
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.channels.oauth.pick')
  const { storeId } = useStore()
  const assets = useOAuthAssets(storeId, sessionId)
  const complete = useCompleteOAuth(storeId, sessionId)

  // The session is dropped when the dialog goes away without a connection: closing it, going to another store
  // or leaving the page. The timer lets React's second mount in development cancel the first cleanup, so a
  // session is dropped only when the dialog is really gone.
  const finished = useRef(false)
  const pending = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  useEffect(() => {
    const key = `${storeId}/${sessionId}`
    // The drop that waits is cancelled only if it is for this same session: the second mount of React in
    // development, not a dialog that now asks for another store or another session
    if (pending.current !== null && pending.current.key === key) clearTimeout(pending.current.timer)
    return () => {
      pending.current = {
        key,
        timer: setTimeout(() => {
          if (!finished.current) dropOAuthSession(storeId, sessionId)
        }, 0)
      }
    }
  }, [storeId, sessionId])

  return (
    <Dialog open onOpenChange={open => (open || complete.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {/* A region that is there from the start, so that the change of its text is announced */}
        <p aria-live="polite" className="sr-only">
          {assets.isPending ? t('loading') : ''}
        </p>
        {assets.isPending ? (
          <p aria-hidden className="text-muted-foreground text-sm">
            {t('loading')}
          </p>
        ) : assets.isError ? (
          <LoadFailure error={assets.error} onClose={onClose} />
        ) : (
          <PickForm
            pluginId={assets.data.pluginId}
            repairing={assets.data.connectionId !== null}
            repairAccountId={assets.data.repairAccountId}
            assets={assets.data.assets}
            complete={complete}
            onDone={(connection, repaired) => {
              finished.current = true
              toast.success(
                t(repaired ? 'repaired' : 'connected', { name: cut(connection.displayName) })
              )
              onClose()
            }}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

// The list could not be read: the reason, and the permissions the person cleared when that is it
function LoadFailure({ error, onClose }: { error: Error; onClose: () => void }): ReactElement {
  const t = useTranslations('settings.channels.oauth.pick')
  const missing = error instanceof ApiError ? missingPermissionsOf(error.metadata) : []
  return (
    <div className="flex flex-col gap-4">
      <ConnectError error={error} />
      {missing.length === 0 ? null : (
        <div className="flex flex-col gap-1.5 text-sm">
          <p>{t('missingIntro')}</p>
          <ul className="list-disc pl-5">
            {missing.map(name => (
              <li key={name}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">{t('missingHelp')}</p>
        </div>
      )}
      <DialogFooter>
        <Button type="button" onClick={onClose}>
          {t('close')}
        </Button>
      </DialogFooter>
    </div>
  )
}

function PickForm({
  pluginId,
  repairing,
  repairAccountId,
  assets,
  complete,
  onDone,
  onClose
}: {
  pluginId: string
  // The login repairs a connection: only the Page it already is will do
  repairing: boolean
  // The account the connection is, to mark the Page that is its own
  repairAccountId: string | null
  assets: readonly OAuthAssetView[]
  complete: ReturnType<typeof useCompleteOAuth>
  onDone: (connection: { displayName: string }, repaired: boolean) => void
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.channels.oauth.pick')
  const tCommon = useTranslations('common')
  const idPrefix = useId()
  const needsInstagram = pluginId === ChannelIds.INSTAGRAM
  const selectable = (asset: OAuthAssetView): boolean =>
    !needsInstagram || asset.linkedAccount !== null
  const onlyChoice = assets.filter(selectable)
  // The Page that is the account of the connection being repaired: the only one that will do
  const isCurrent = (asset: OAuthAssetView): boolean =>
    repairAccountId !== null &&
    (asset.id === repairAccountId || asset.linkedAccount?.id === repairAccountId)
  const current = assets.find(isCurrent)
  const [choice, setChoice] = useState<string | null>(
    current !== undefined && selectable(current)
      ? current.id
      : onlyChoice.length === 1
        ? (onlyChoice[0]?.id ?? null)
        : null
  )
  // Nothing was found, or the person does not see theirs: they type the number of the Page
  const [typing, setTyping] = useState(assets.length === 0)
  const [typed, setTyped] = useState('')
  const typedValid = MetaOAuth.ASSET_ID_PATTERN.test(typed.trim())
  const assetId = typing ? (typedValid ? typed.trim() : null) : choice
  const guard = useSubmitGuard()
  const errorId = `${idPrefix}-error`

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (assetId === null || complete.isPending || !guard.enter()) return
    complete.mutate(assetId, {
      onSuccess: connection => onDone(connection, repairing),
      onSettled: guard.leave
    })
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {repairing ? <p className="text-sm">{t('repairHint')}</p> : null}
      {assets.length === 0 ? <p className="text-sm">{t('none')}</p> : null}
      {assets.length > 0 && !typing ? (
        <fieldset className="grid grid-cols-1 gap-2" disabled={complete.isPending}>
          <legend className="mb-1 text-sm font-medium">{t('legend')}</legend>
          <div className="grid grid-cols-1 gap-2">
            {assets.map(asset => {
              const id = `${idPrefix}-${asset.id}`
              const ok = selectable(asset)
              return (
                <label
                  key={asset.id}
                  htmlFor={id}
                  className="has-[:checked]:border-primary flex items-start gap-3 rounded-lg border p-3 has-[:disabled]:opacity-60"
                >
                  <input
                    id={id}
                    type="radio"
                    name={`${idPrefix}-page`}
                    value={asset.id}
                    checked={choice === asset.id}
                    disabled={!ok}
                    onChange={() => setChoice(asset.id)}
                    className="mt-1"
                  />
                  <span className="grid min-w-0 grid-cols-1 gap-0.5">
                    <span className="truncate font-medium">{cut(asset.name)}</span>
                    {isCurrent(asset) ? (
                      <span className="text-muted-foreground truncate text-sm">
                        {t('currentPage')}
                      </span>
                    ) : null}
                    {needsInstagram ? (
                      <span className="text-muted-foreground truncate text-sm">
                        {asset.linkedAccount === null
                          ? t('noInstagram')
                          : t('instagram', {
                              username: cut(asset.linkedAccount.username ?? asset.linkedAccount.id)
                            })}
                      </span>
                    ) : null}
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>
      ) : null}
      {assets.length > 0 && !typing && onlyChoice.length === 0 ? (
        <p role="note" className="text-sm">
          {t('noneSelectable')}
        </p>
      ) : null}
      {typing ? (
        <div className="grid grid-cols-1 gap-1.5">
          <Label htmlFor={`${idPrefix}-typed`}>{t('typedLabel')}</Label>
          <Input
            id={`${idPrefix}-typed`}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={event => setTyped(event.target.value)}
            disabled={complete.isPending}
            aria-invalid={typed !== '' && !typedValid ? true : undefined}
            aria-describedby={`${idPrefix}-typed-hint${complete.isError ? ` ${errorId}` : ''}`}
          />
          <p id={`${idPrefix}-typed-hint`} className="text-muted-foreground text-xs">
            {t('typedHint')}
          </p>
        </div>
      ) : null}
      {assets.length > 0 ? (
        <Button
          type="button"
          variant="ghost"
          className="self-start px-0 underline"
          disabled={complete.isPending}
          onClick={() => setTyping(!typing)}
        >
          {typing ? t('backToList') : t('notListed')}
        </Button>
      ) : null}
      {repairing &&
      connectFailureReasonOf(complete.error) === ChannelConnectFailureReasons.OTHER_ACCOUNT ? (
        // The text of the pasted token talks of a token: here the person picked another Page
        <p id={errorId} role="alert" className="text-destructive text-sm">
          {t('otherAccount')}
        </p>
      ) : (
        <ConnectError error={complete.error} id={errorId} />
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={complete.isPending}>
          {tCommon('cancel')}
        </Button>
        <Button type="submit" disabled={assetId === null || complete.isPending}>
          {complete.isPending ? t('connecting') : t('submit')}
        </Button>
      </DialogFooter>
    </form>
  )
}
