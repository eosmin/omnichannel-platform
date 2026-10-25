import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentPermissions,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import { type InvitationView, InvitationsService } from './invitations.service'
import { type MemberView, MembersService } from './members.service'
import { type RoleView, RolesService } from './roles.service'
import {
  type ChangeMemberRoleBody,
  changeMemberRoleSchema,
  type CreateRoleBody,
  createRoleSchema,
  idSchema,
  type InviteMemberBody,
  inviteMemberSchema,
  type UpdateRoleBody,
  updateRoleSchema
} from './team.schemas'

const HTTP_CREATED = 201
const HTTP_NO_CONTENT = 204

// The team of the store in X-Store-Id: its members and the roles they can hold
@Controller()
export class TeamController {
  constructor(
    private readonly members: MembersService,
    private readonly roles: RolesService,
    private readonly invitations: InvitationsService
  ) {}

  @RequirePermissions(Permissions.TEAM_VIEW)
  @Get(ApiRoutes.settings.members)
  listMembers(@CurrentStore() store: { id: string }): Promise<MemberView[]> {
    return this.members.list(store.id)
  }

  // Inviting creates no member: the invitee is one once they accept (Step 1.4)
  @RequirePermissions(Permissions.TEAM_INVITE)
  @Post(ApiRoutes.settings.members)
  @HttpCode(HTTP_CREATED)
  inviteMember(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(inviteMemberSchema)) body: InviteMemberBody,
    @Req() req: AuthenticatedRequest
  ): Promise<InvitationView> {
    return this.invitations.invite(store, body, actorOf(user, store, req), held)
  }

  @RequirePermissions(Permissions.TEAM_VIEW)
  @Get(ApiRoutes.settings.invitations)
  listInvitations(@CurrentStore() store: { id: string }): Promise<InvitationView[]> {
    return this.invitations.list(store.id)
  }

  @RequirePermissions(Permissions.TEAM_INVITE)
  @Delete(ApiRoutes.settings.invitationById(':id'))
  @HttpCode(HTTP_NO_CONTENT)
  async revokeInvitation(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.invitations.revoke(store.id, id, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.TEAM_MANAGE_ROLES)
  @Patch(ApiRoutes.settings.memberById(':id'))
  changeMemberRole(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(changeMemberRoleSchema)) body: ChangeMemberRoleBody,
    @Req() req: AuthenticatedRequest
  ): Promise<MemberView> {
    return this.members.changeRole(store.id, id, body.roleId, actorOf(user, store, req), held)
  }

  @RequirePermissions(Permissions.TEAM_REMOVE)
  @Delete(ApiRoutes.settings.memberById(':id'))
  @HttpCode(HTTP_NO_CONTENT)
  async removeMember(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.members.remove(store.id, id, actorOf(user, store, req), held)
  }

  @RequirePermissions(Permissions.TEAM_VIEW)
  @Get(ApiRoutes.settings.roles)
  listRoles(@CurrentStore() store: { id: string }): Promise<RoleView[]> {
    return this.roles.list(store.id)
  }

  @RequirePermissions(Permissions.TEAM_MANAGE_ROLES)
  @Post(ApiRoutes.settings.roles)
  @HttpCode(HTTP_CREATED)
  createRole(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(createRoleSchema)) body: CreateRoleBody,
    @Req() req: AuthenticatedRequest
  ): Promise<RoleView> {
    return this.roles.create(store.id, body, actorOf(user, store, req), held)
  }

  @RequirePermissions(Permissions.TEAM_MANAGE_ROLES)
  @Patch(ApiRoutes.settings.roleById(':id'))
  updateRole(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) body: UpdateRoleBody,
    @Req() req: AuthenticatedRequest
  ): Promise<RoleView> {
    return this.roles.update(store.id, id, body, actorOf(user, store, req), held)
  }

  @RequirePermissions(Permissions.TEAM_MANAGE_ROLES)
  @Delete(ApiRoutes.settings.roleById(':id'))
  @HttpCode(HTTP_NO_CONTENT)
  async deleteRole(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.roles.remove(store.id, id, actorOf(user, store, req))
  }
}
