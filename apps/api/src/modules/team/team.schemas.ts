import { z } from 'zod'

import { isPermission } from '../tenancy'

const MAX_NAME_LENGTH = 60
const MAX_DESCRIPTION_LENGTH = 255

export const idSchema = z.uuid()

const permissionList = z
  .array(z.string().refine(isPermission, { message: 'not a permission' }))
  .transform(permissions => [...new Set(permissions)]) // A repeated one is the same permission

const roleName = z.string().trim().min(1).max(MAX_NAME_LENGTH)
const roleDescription = z.string().trim().max(MAX_DESCRIPTION_LENGTH)

// 254 is the longest address SMTP allows (RFC 5321)
const MAX_EMAIL_LENGTH = 254

export const inviteMemberSchema = z.strictObject({
  email: z.email().max(MAX_EMAIL_LENGTH),
  roleId: z.uuid()
})

export const changeMemberRoleSchema = z.strictObject({ roleId: z.uuid() })

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
