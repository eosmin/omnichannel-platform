'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { InvitationsPanel } from '../../components/settings/team-invitations-panel'
import { MembersPanel } from '../../components/settings/team-members-panel'
import { RolesPanel } from '../../components/settings/team-roles-panel'
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs'
import type { InvitationView, MemberView, RoleView } from '../../lib/settings/team-requests'
import { useInvitations, useMembers, useRoles } from '../../lib/settings/use-team'

const TeamTabs = { MEMBERS: 'members', ROLES: 'roles', INVITATIONS: 'invitations' } as const
type TeamTab = (typeof TeamTabs)[keyof typeof TeamTabs]

// Settings → Store → Team (TDD_09 §13): members, custom roles with the matrix of permissions, and
// invitations. The page needs TEAM_VIEW, which is what the api asks for the three lists.
export function StoreTeamPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.TEAM_VIEW) ? (
    <TeamLoader />
  ) : (
    <PermissionDenied permission={ClientPermissions.TEAM_VIEW} />
  )
}

function TeamLoader(): ReactElement {
  const { storeId } = useStore()
  const members = useMembers(storeId, true)
  const roles = useRoles(storeId, true)
  const invitations = useInvitations(storeId, true)
  const failed = [members, roles, invitations].find(query => query.isError)
  if (failed !== undefined) {
    return (
      <LoadFailed
        error={failed.error}
        onRetry={() => {
          for (const query of [members, roles, invitations]) if (query.isError) void query.refetch()
        }}
      />
    )
  }
  if (members.data === undefined || roles.data === undefined || invitations.data === undefined) {
    return <PageLoading />
  }
  return <TeamBody members={members.data} roles={roles.data} invitations={invitations.data} />
}

function TeamBody({
  members,
  roles,
  invitations
}: {
  members: MemberView[]
  roles: RoleView[]
  invitations: InvitationView[]
}): ReactElement {
  const t = useTranslations('settings.team')
  const [tab, setTab] = useState<TeamTab>(TeamTabs.MEMBERS)
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <Tabs value={tab} onValueChange={value => setTab(value as TeamTab)}>
        <TabsList aria-label={t('tabsLabel')}>
          <TabsTrigger value={TeamTabs.MEMBERS}>{t('tabs.members')}</TabsTrigger>
          <TabsTrigger value={TeamTabs.ROLES}>{t('tabs.roles')}</TabsTrigger>
          <TabsTrigger value={TeamTabs.INVITATIONS}>{t('tabs.invitations')}</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === TeamTabs.MEMBERS ? <MembersPanel members={members} roles={roles} /> : null}
      {tab === TeamTabs.ROLES ? <RolesPanel roles={roles} /> : null}
      {tab === TeamTabs.INVITATIONS ? (
        <InvitationsPanel invitations={invitations} roles={roles} />
      ) : null}
    </section>
  )
}
