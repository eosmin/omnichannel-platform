import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

// A capability and the method that has to exist for the plugin to keep its promise
export type CapabilityMethod<C extends string, P> = readonly [C, keyof P & string]

// How an id from a plugin that has not been checked yet goes into a message: cut, escaped (a line
// break cannot start a new log line) and, if it is not a string, only its type
export function printable(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value.slice(0, 40)) : `<${typeof value}>`
}

export function pluginNotFound(kind: 'Plugin' | 'Carrier', id: string): PlatformException {
  return new PlatformException(
    ErrorCodes.PLUGIN_NOT_FOUND,
    `${kind} ${id} not found`,
    HttpStatusCodes.NOT_FOUND
  )
}

export function pluginAlreadyRegistered(kind: 'Plugin' | 'Carrier', id: string): PlatformException {
  return new PlatformException(
    ErrorCodes.PLUGIN_ALREADY_REGISTERED,
    `${kind} ${id} already registered`
  )
}

export function contractViolation(message: string): PlatformException {
  return new PlatformException(ErrorCodes.PLUGIN_CONTRACT_VIOLATION, message)
}

// A copy of the list a plugin declares, taken once; anything else is left for the contract check to
// refuse
export function snapshotCapabilities<C extends string>(declared: readonly C[]): readonly C[] {
  return Array.isArray(declared) ? declared.slice() : declared
}

// Fails fast, at boot: a plugin that declares a capability it cannot fulfil would otherwise fail
// the first time somebody uses it. The caller passes the id and the capabilities it read once.
export function assertMethodsForCapabilities<C extends string, P>(
  id: string,
  capabilities: readonly C[],
  plugin: P,
  rules: ReadonlyArray<CapabilityMethod<C, P>>
): void {
  if (!Array.isArray(capabilities)) {
    throw contractViolation(`Plugin ${printable(id)} does not declare its capabilities`)
  }
  for (const [capability, method] of rules) {
    if (capabilities.includes(capability) && typeof plugin[method] !== 'function') {
      throw contractViolation(
        `Plugin ${printable(id)} declares ${capability} but does not implement ${method}`
      )
    }
  }
}
