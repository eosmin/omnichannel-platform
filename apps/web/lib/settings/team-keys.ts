// The query keys of Settings → Team, kept with the page that reads them (see channel-keys.ts)
export const TeamKeys = {
  root: (storeId: string) => ['team', storeId] as const,
  members: (storeId: string) => ['team', storeId, 'members'] as const,
  roles: (storeId: string) => ['team', storeId, 'roles'] as const,
  invitations: (storeId: string) => ['team', storeId, 'invitations'] as const
}
