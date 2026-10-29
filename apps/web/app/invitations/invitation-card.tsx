'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import {
  ApiError,
  AppPaths,
  fetchInvitationPreview,
  type InvitationPreview,
  QueryKeys
} from '@platform/api-client'
import { ErrorCodes, HttpStatusCodes, RefusalReasons } from '@platform/core/errors'

import { SignOutButton } from '../../components/auth/sign-out-button'
import { LoadingScreen } from '../../components/shell/session-gate'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { apiClient, browserSession } from '../../lib/api'
import { errorCodeOf } from '../../lib/error-message'
import { useProfile } from '../../lib/use-profile'

type Refusal =
  { kind: 'loginRequired' } | { kind: 'nameRequired' } | { kind: 'error'; error: unknown }

function isNoSession(error: unknown): boolean {
  return error instanceof ApiError && error.status === HttpStatusCodes.UNAUTHORIZED
}

function refusalOf(error: unknown): Refusal {
  if (error instanceof ApiError) {
    if (
      error.status === HttpStatusCodes.UNAUTHORIZED &&
      error.metadata.reason === RefusalReasons.LOGIN_REQUIRED
    ) {
      return { kind: 'loginRequired' }
    }
    if (error.is(ErrorCodes.VALIDATION_FAILED)) return { kind: 'nameRequired' }
  }
  return { kind: 'error', error }
}

// The page of the link in the invitation email. Three people arrive here: one with no account (the
// name they type creates it, and the session comes back with the answer), one with an account who is
// signed in as the invited address (the membership is created), and one who is signed in as someone
// else (told to sign out). One with an account and no session is sent to sign in by the api's answer.
export function InvitationCard({ token }: { token: string }): ReactElement {
  const t = useTranslations()
  const preview = useQuery({
    queryKey: QueryKeys.invitations.byToken(token),
    queryFn: ({ signal }) => fetchInvitationPreview(apiClient, token, signal)
  })
  const profile = useProfile()

  if (preview.isError) {
    return (
      <Frame>
        <p role="alert">{t(`errors.${errorCodeOf(preview.error)}`)}</p>
        <Button asChild>
          <Link href={AppPaths.login}>{t('invitation.goToLogin')}</Link>
        </Button>
      </Frame>
    )
  }
  if (preview.data === undefined || profile.isPending) return <LoadingScreen />
  // A profile that failed for another reason than "no session" must not pass for an anonymous visit:
  // the person could be signed in, and would be told otherwise
  if (profile.isError && !isNoSession(profile.error)) {
    return (
      <Frame>
        <p role="alert">{t(`errors.${errorCodeOf(profile.error)}`)}</p>
        <Button onClick={() => void profile.refetch()}>{t('common.tryAgain')}</Button>
      </Frame>
    )
  }

  const signedInAs = profile.data?.email
  if (signedInAs !== undefined && signedInAs.toLowerCase() !== preview.data.email.toLowerCase()) {
    return (
      <Frame>
        <h1 className="text-2xl font-semibold">{t('invitation.mismatchTitle')}</h1>
        <p className="text-muted-foreground">
          {t('invitation.mismatchBody', { current: signedInAs, invited: preview.data.email })}
        </p>
        <SignOutButton redirectTo={AppPaths.invitation(token)} />
      </Frame>
    )
  }
  return <AcceptForm token={token} invitation={preview.data} signedIn={signedInAs !== undefined} />
}

function Frame({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-4">
      {children}
    </main>
  )
}

function AcceptForm({
  token,
  invitation,
  signedIn
}: {
  token: string
  invitation: InvitationPreview
  signedIn: boolean
}): ReactElement {
  const t = useTranslations()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)

  async function accept(event: FormEvent): Promise<void> {
    event.preventDefault()
    setPending(true)
    setRefusal(null)
    try {
      const accepted = await browserSession.acceptInvitation(token, name.trim() || undefined)
      // The profile in the cache does not have the new store yet
      await queryClient.invalidateQueries({ queryKey: QueryKeys.session })
      router.replace(AppPaths.store.inbox(accepted.store.id))
    } catch (error) {
      setRefusal(refusalOf(error))
      setPending(false)
    }
  }

  return (
    <Frame>
      <form
        className="flex flex-col gap-4"
        onSubmit={event => {
          void accept(event)
        }}
      >
        <h1 className="text-2xl font-semibold">{t('invitation.title')}</h1>
        <p className="text-muted-foreground">
          {t('invitation.body', {
            inviter: invitation.inviterName,
            store: invitation.storeName,
            role: invitation.roleName
          })}
        </p>
        {!signedIn && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">{t('invitation.nameLabel')}</Label>
            <Input
              id="name"
              autoComplete="name"
              value={name}
              onChange={event => setName(event.target.value)}
            />
            <p className="text-muted-foreground text-sm">{t('invitation.nameHint')}</p>
          </div>
        )}
        {refusal !== null && <RefusalMessage refusal={refusal} email={invitation.email} />}
        <Button type="submit" disabled={pending}>
          {pending ? t('invitation.accepting') : t('invitation.accept')}
        </Button>
      </form>
    </Frame>
  )
}

function RefusalMessage({ refusal, email }: { refusal: Refusal; email: string }): ReactElement {
  const t = useTranslations()
  if (refusal.kind === 'loginRequired') {
    return (
      <div role="alert" className="flex flex-col gap-2">
        <p className="text-destructive text-sm">{t('invitation.loginRequired', { email })}</p>
        <Button asChild variant="outline">
          <Link href={AppPaths.login}>{t('invitation.goToLogin')}</Link>
        </Button>
      </div>
    )
  }
  const message =
    refusal.kind === 'nameRequired'
      ? t('invitation.nameRequired')
      : t(`errors.${errorCodeOf(refusal.error)}`)
  return (
    <p role="alert" className="text-destructive text-sm">
      {message}
    </p>
  )
}
