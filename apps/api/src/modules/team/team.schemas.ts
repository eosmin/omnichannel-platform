import { z } from 'zod'

import { unmetPermissionRequirements } from '@platform/core/auth'
import { lowercasedUuidSchema } from '@platform/core/domain'

import { isPermission } from '../tenancy'

const MAX_NAME_LENGTH = 60
const MAX_DESCRIPTION_LENGTH = 255

export const idSchema = lowercasedUuidSchema

const permissionList = z
  .array(z.string().refine(isPermission, { message: 'not a permission' }))
  .transform(permissions => [...new Set(permissions)]) // A repeated one is the same permission
  // A permission that needs another is never held without it (registering a transaction needs seeing it)
  .refine(permissions => unmetPermissionRequirements(permissions).length === 0, {
    message: 'a permission needs another one the role does not hold'
  })

const roleName = z.string().trim().min(1).max(MAX_NAME_LENGTH)
const roleDescription = z.string().trim().max(MAX_DESCRIPTION_LENGTH)

// 254 is the longest address SMTP allows (RFC 5321)
const MAX_EMAIL_LENGTH = 254

export const inviteMemberSchema = z.strictObject({
  email: z.email().max(MAX_EMAIL_LENGTH),
  roleId: lowercasedUuidSchema
})

export const changeMemberRoleSchema = z.strictObject({ roleId: lowercasedUuidSchema })

export const createRoleSchema = z.strictObject({
  name: roleName,
  description: roleDescription.optional(),
  permissions: permissionList
})

export const updateRoleSchema = z
  .strictObject({
    name: roleName.optional(),
    description: roleDescription.nullable().optional(),
    permissions: permissionList.optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })

export type InviteMemberBody = z.output<typeof inviteMemberSchema>
export type ChangeMemberRoleBody = z.output<typeof changeMemberRoleSchema>
export type CreateRoleBody = z.output<typeof createRoleSchema>
export type UpdateRoleBody = z.output<typeof updateRoleSchema>
