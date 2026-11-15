// The metadata key of the scopes a plugin-api route needs, apart from the decorator so that the guard that reads it and the
// decorator that sets it do not import each other
export const PLUGIN_SCOPES_KEY = 'requiredPluginScopes'
