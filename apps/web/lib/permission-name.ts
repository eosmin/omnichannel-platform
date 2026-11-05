// The message path of the name that the team settings give a permission ("Gestionar el equipo"), so a
// refusal can say what is missing in the same words. The permission `settings:view` is
// `settings.team.permissions.settings.view`.
export function permissionNameKey(permission: string): string {
  return `settings.team.permissions.${permission.replace(':', '.')}`
}
