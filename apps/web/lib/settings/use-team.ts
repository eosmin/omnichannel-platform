'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import { QueryKeys } from '@platform/api-client'

import { apiClient } from '../api'

import { TeamKeys } from './team-keys'
import {
  changeMemberRole,
  createRole,
  deleteRole,
  fetchInvitations,
  fetchMembers,
  fetchRoles,
  type InvitationView,
  inviteMember,
  type MemberView,
  reactivateMember,
  removeMember,
  resendInvitation,
  revokeInvitation,
  type RoleInput,
  type RoleView,
  suspendMember,
  updateRole
} from './team-requests'

// The hooks of Settings → Team. Only that page loads this file. The three lists are enabled one by
// one: a person who may not read the team (TEAM_VIEW) never asks for them.

export function useMembers(storeId: string, enabled: boolean): UseQueryResult<MemberView[]> {
  return useQuery({
    queryKey: TeamKeys.members(storeId),
    queryFn: ({ signal }) => fetchMembers(apiClient, storeId, signal),
    enabled
  })
}

export function useRoles(storeId: string, enabled: boolean): UseQueryResult<RoleView[]> {
  return useQuery({
    queryKey: TeamKeys.roles(storeId),
    queryFn: ({ signal }) => fetchRoles(apiClient, storeId, signal),
    enabled
  })
}

export function useInvitations(
  storeId: string,
  enabled: boolean
): UseQueryResult<InvitationView[]> {
  return useQuery({
    queryKey: TeamKeys.invitations(storeId),
    queryFn: ({ signal }) => fetchInvitations(apiClient, storeId, signal),
    enabled
  })
}

// A role changes who the members and the pending invitations are said to be, and the other way round,
// so one change reads the three lists again
function useRefreshTeam(storeId: string): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: TeamKeys.root(storeId) })
    // The inbox names assignees and authors from the directory of active members
    void queryClient.invalidateQueries({ queryKey: QueryKeys.members.directory(storeId) })
  }
}

export function useChangeMemberRole(
  storeId: string
): UseMutationResult<MemberView, Error, { memberId: string; roleId: string }> {
  const refresh = useRefreshTeam(storeId)
  return useMutation({
    mutationFn: ({ memberId, roleId }) => changeMemberRole(apiClient, storeId, memberId, roleId),
    onSettled: refresh
  })
}

export function useRemoveMember(storeId: string): UseMutationResult<undefined, Error, string> {
  const refresh = useRefreshTeam(storeId)
  return useMutation({
    mutationFn: (memberId: string) => removeMember(apiClient, storeId, memberId),
    onSettled: refresh
  })
}

export function useSuspendMember(storeId: string): UseMutationResult<MemberView, Error, string> {
  const refresh = useRefreshTeam(storeId)
  return useMutation({
    mutationFn: (memberId: string) => suspendMember(apiClient, storeId, memberId),
    // Also on failure: a conflict means the list was stale
    onSettled: refresh
  })
}

export function useReactivateMember(storeId: string): UseMutationResult<MemberView, Error, string> {
  const refresh = useRefreshTeam(storeId)
  return useMutation({
    mutationFn: (memberId: string) => reactivateMember(apiClient, storeId, memberId),
    onSettled: refresh
  })
}

export function useCreateRole(storeId: string): UseMutationResult<RoleView, Error, RoleInput> {
  const refresh = useRefreshTeam(storeId)
  return useMutation({
    mutationFn: (input: RoleInput) => createRole(apiClient, storeId, input),
    onSuccess: refresh
  })
}

export function useUpdateRole(
  storeId: string
): UseMutationResult<RoleView, Error, { roleId: string; input: Partial<RoleInput> }> {
  const refresh = useRefreshTeam(storeId)
  return useMutation({
    mutationFn: ({ roleId, input }) => updateRole(apiClient, storeId, roleId, input),
    onSuccess: refresh
  })
}

export function useDeleteRole(storeId: string): UseMutationResult<undefined, Error, string> {
  const refresh = useRefreshTeam(storeId)
  return useMutation({
    mutationFn: (roleId: string) => deleteRole(apiClient, storeId, roleId),
    onSettled: refresh
  })
}

export function useInviteMember(
  storeId: string
): UseMutationResult<InvitationView, Error, { email: string; roleId: string }> {
  const refresh = useRefreshTeam(storeId)
  return useMutation({
    mutationFn: input => inviteMember(apiClient, storeId, input),
    onSuccess: refresh
  })
}

export function useResendInvitation(
  storeId: string
): UseMutationResult<InvitationView, Error, string> {
  const refresh = useRefreshTeam(storeId)
  return useMutation({
    mutationFn: (invitationId: string) => resendInvitation(apiClient, storeId, invitationId),
    // A resend that is refused (cooldown) leaves the list as it was; one that went through replaces the row
    onSuccess: refresh
  })
}

export function useRevokeInvitation(storeId: string): UseMutationResult<undefined, Error, string> {
  const refresh = useRefreshTeam(storeId)
  return useMutation({
    mutationFn: (invitationId: string) => revokeInvitation(apiClient, storeId, invitationId),
    onSettled: refresh
  })
}
