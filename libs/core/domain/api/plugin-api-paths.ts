// A path with its parameters as ':p', so that '/plugin-api/orders/:id' and '/plugin-api/orders/:orderId' are the same route
export function normalizedPluginApiPath(path: string): string {
  return path.replace(/:[A-Za-z][A-Za-z0-9]*/g, ':p')
}

// Builders take only their required string parameters (no default, no rest), because each one is called with one placeholder per
// declared parameter.
// The plugin-api paths that `PluginApiRoutes` declares (a path, or a builder that is called with a placeholder for each of its
// parameters), normalized. A value that is not under /plugin-api/ is reported, because what the map points to must be one.
export function pluginApiPaths(routes: Readonly<Record<string, unknown>>): {
  paths: Set<string>
  outside: string[]
} {
  const paths = new Set<string>()
  const outside: string[] = []
  const visit = (tree: Readonly<Record<string, unknown>>, prefix: string): void => {
    for (const [key, value] of Object.entries(tree)) {
      const name = prefix === '' ? key : `${prefix}.${key}`
      const path =
        typeof value === 'function'
          ? String(
              (value as (...args: string[]) => unknown)(...Array<string>(value.length).fill(':p'))
            )
          : value
      if (typeof path === 'string') {
        if (path.startsWith('/plugin-api/')) paths.add(normalizedPluginApiPath(path))
        else outside.push(name)
      } else if (typeof path === 'object' && path !== null) {
        visit(path as Record<string, unknown>, name)
      }
    }
  }
  visit(routes, '')
  return { paths, outside }
}
