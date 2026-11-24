import { missingPermissionsOf } from '../error-message'

// The first of several failed reads that was a refusal for lack of permission, or null when none was. A form that reads from several
// places (the suppliers, the warehouses) says which permission is missing instead of "try again", which cannot help.
export function permissionRefusalOf(errors: readonly unknown[]): unknown {
  return errors.find(error => missingPermissionsOf(error).length > 0) ?? null
}
