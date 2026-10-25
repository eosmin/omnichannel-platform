// Importing a controller imports the platform modules, which parse the env of the app: the same
// base the integration suites use (see the file)
import '../../testing/load-example-env'

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'

import { IS_PUBLIC_KEY } from '@platform/core/auth-module'

import { PERMISSIONS_KEY, SKIP_TENANT_KEY } from './decorators'

// Every route of the platform has to say what protects it (CLAUDE.md, rule 5): public on purpose, a
// person's own (@SkipTenant), or a store's with @RequirePermissions. The guards refuse the rest at
// run time; this test refuses it before it merges, for every controller there is, found by name
// and not listed by hand, so that a new controller cannot be forgotten.
const ROOTS = [resolve(__dirname, '../..'), resolve(__dirname, '../../../../../libs/core')]
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'testing', 'generated', 'dist'])

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) {
      return SKIPPED_DIRECTORIES.has(name) ? [] : sourceFiles(path)
    }
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : []
  })
}

function controllerFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) {
      return SKIPPED_DIRECTORIES.has(name) ? [] : controllerFiles(path)
    }
    return name.endsWith('.controller.ts') ? [path] : []
  })
}

interface Route {
  controller: string
  handler: string
  isPublic: boolean
  skipsTenant: boolean
  permissions: string[]
}

function read<T>(key: string, target: object): T | undefined {
  return Reflect.getMetadata(key, target) as T | undefined
}

function routesOf(file: string): Route[] {
  const exported = jest.requireActual<Record<string, unknown>>(file)
  return Object.values(exported).flatMap(value => {
    if (typeof value !== 'function' || read(PATH_METADATA, value) === undefined) return []
    const controller = value as { prototype: Record<string, unknown>; name: string }
    return Object.getOwnPropertyNames(controller.prototype).flatMap(name => {
      const handler = controller.prototype[name]
      if (typeof handler !== 'function' || read(METHOD_METADATA, handler) === undefined) return []
      return [
        {
          controller: controller.name,
          handler: name,
          isPublic:
            read<boolean>(IS_PUBLIC_KEY, handler) === true ||
            read<boolean>(IS_PUBLIC_KEY, controller) === true,
          skipsTenant:
            read<boolean>(SKIP_TENANT_KEY, handler) === true ||
            read<boolean>(SKIP_TENANT_KEY, controller) === true,
          permissions: [
            ...(read<string[]>(PERMISSIONS_KEY, controller) ?? []),
            ...(read<string[]>(PERMISSIONS_KEY, handler) ?? [])
          ]
        }
      ]
    })
  })
}

describe('the protection of every route', () => {
  const routes = ROOTS.flatMap(controllerFiles).flatMap(routesOf)
  const label = (route: Route): string => `${route.controller}.${route.handler}`

  it('finds the controllers of the platform, so that an empty scan cannot pass', () => {
    const controllers = new Set(routes.map(route => route.controller))

    for (const name of [
      'AuthController',
      'ResendWebhookController',
      'HealthController',
      'MetricsController'
    ]) {
      expect(controllers.has(name)).toBe(true)
    }
    expect(routes.length).toBeGreaterThanOrEqual(10)
  })

  // The scan finds controllers by the name of their file. One declared somewhere else would never be
  // looked at, so every file that declares one has to be named like one.
  it('finds a controller in no file that is not named *.controller.ts', () => {
    const misnamed = ROOTS.flatMap(sourceFiles)
      .filter(file => !file.endsWith('.controller.ts'))
      .filter(file => /^\s*@Controller\(/m.test(readFileSync(file, 'utf8')))

    expect(misnamed).toEqual([])
  })

  it("leaves no route without a protection: public, a person's own, or a store's permission", () => {
    const unprotected = routes
      .filter(route => !route.isPublic && !route.skipsTenant && route.permissions.length === 0)
      .map(label)

    expect(unprotected).toEqual([])
  })

  // A permission on a route that skips the guards would never be checked: the author thinks the
  // route is protected and it is not. (@Public on a method of a @SkipTenant class is fine.)
  it('does not declare permissions on a route that is exempt from the guards', () => {
    const misleading = routes
      .filter(route => (route.isPublic || route.skipsTenant) && route.permissions.length > 0)
      .map(label)

    expect(misleading).toEqual([])
  })
})
