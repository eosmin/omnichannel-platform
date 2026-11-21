import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { EXTERNAL_IO_PROVIDERS } from '../external-io-providers'

import {
  baselineGrowth,
  fixedEntries,
  localMethodProblems,
  networkFunctionsOf,
  newlyUnmarked,
  parseClasses,
  providerRoots,
  stalePureTypes,
  unknownFieldTypes,
  unknownProviders,
  unmarkedExternalRoutes
} from './external-io-routes'

const PROVIDERS = [{ name: 'StorageService', reason: 'the bucket' }]

const SERVICE = `
class FilesService {
  constructor(private readonly storage: StorageService, private readonly prisma: PrismaService) {}
  sign(id: string) { return this.storage.presign(id) }
  outer(id: string) { return this.sign(id) }
  readOnly(id: string) { return this.prisma.client.file.findMany() }
}
`

function routes(controller: string, extra = '') {
  const classes = [
    ...parseClasses('a/files.service.ts', SERVICE),
    ...parseClasses('a/files.controller.ts', controller),
    ...(extra === '' ? [] : parseClasses('a/extra.ts', extra))
  ]
  return unmarkedExternalRoutes(classes, PROVIDERS).map(r => r.key)
}

const controller = (body: string, decorators = ''): string => `
@Controller('files')
${decorators}
class FilesController {
  constructor(private readonly files: FilesService) {}
  ${body}
}
`

describe('unmarkedExternalRoutes', () => {
  it('flags a route that calls a provider through a service', () => {
    expect(routes(controller('@Get() list() { return this.files.sign("x") }'))).toEqual([
      'a/files.controller.ts#FilesController.list'
    ])
  })

  it('follows a call through the methods of the same service', () => {
    expect(routes(controller('@Post() make() { return this.files.outer("x") }'))).toHaveLength(1)
  })

  it('does not flag a route that stays in the database', () => {
    expect(routes(controller('@Get() list() { return this.files.readOnly("x") }'))).toEqual([])
  })

  it('accepts the mark on the method or on the class', () => {
    expect(
      routes(
        controller("@NoTenantTransaction('presign') @Get() a() { return this.files.sign('x') }")
      )
    ).toEqual([])
    expect(
      routes(controller("@Get() a() { return this.files.sign('x') }", "@NoTenantTransaction('io')"))
    ).toEqual([])
  })

  it('flags the call to an adapter method on a local variable and to fetch', () => {
    expect(
      routes(`@Controller() class C { @Post() send(a: any) { return a.sendMessage(1) } }`)
    ).toHaveLength(1)
    expect(routes(`@Controller() class C { @Get() g() { return fetch('x') } }`)).toHaveLength(1)
  })

  it('flags @Res() and @UploadedFile() but not @Res({ passthrough: true })', () => {
    expect(routes(`@Controller() class C { @Get() g(@Res() res: R) { return 1 } }`)).toHaveLength(1)
    expect(
      routes(`@Controller() class C { @Post() g(@UploadedFile() f: F) { return 1 } }`)
    ).toHaveLength(1)
    expect(
      routes(`@Controller() class C { @Get() g(@Res({ passthrough: true }) res: R) { return 1 } }`)
    ).toEqual([])
  })

  it('ignores a method that is not a route, and a class that is not a controller', () => {
    expect(routes(controller('helper() { return this.files.sign("x") }'))).toEqual([])
    expect(
      routes(
        `class Plain { constructor(private readonly files: FilesService) {} @Get() g() { return this.files.sign(1) } }`
      )
    ).toEqual([])
  })
})

describe('what the scan follows', () => {
  it('flags a network method called on a field whose type is not a class of the scan', () => {
    expect(
      routes(
        `@Controller() class C { constructor(private readonly port: ChannelPort) {} @Post() s() { return this.port.sendMessage(1) } }`
      )
    ).toHaveLength(1)
  })

  it('reads a field typed with null or undefined', () => {
    expect(
      routes(
        `@Controller() class C { constructor(private readonly files: FilesService | null) {} @Get() g() { return this.files?.sign(1) } }`
      )
    ).toHaveLength(1)
    expect(
      routes(
        `@Controller() class C { constructor(private readonly files: FilesService | null) {} @Get() g() { return this.files.sign(1) } }`
      )
    ).toHaveLength(1)
  })

  it('follows this.method() and the fields into a base class', () => {
    const base = `abstract class Base { constructor(protected readonly files: FilesService) {} protected store() { return this.files.sign(1) } }`
    expect(
      routes(`@Controller() class C extends Base { @Post() up() { return this.store() } }`, base)
    ).toHaveLength(1)
  })
})

describe('providers by import', () => {
  const CLIENT = `import axios from 'axios'\nclass RemoteClient { get() { return axios.get('x') } }\nclass OtherInFile { run() { return 1 } }`
  const typeOnly = `import type { AxiosInstance } from 'axios'\nclass Shape { constructor(private readonly h: AxiosInstance) {} }`
  const reach = (client: string, controllerBody: string): string[] => {
    const classes = [
      ...parseClasses('a/client.ts', client),
      ...parseClasses(
        'a/c.ts',
        `@Controller() class C { constructor(private readonly remote: RemoteClient) {} ${controllerBody} }`
      )
    ]
    return unmarkedExternalRoutes(classes, []).map(r => r.key)
  }

  it('treats every class of a file that imports a network module as a provider', () => {
    const classes = parseClasses('a/client.ts', CLIENT)
    expect([...providerRoots(classes, [])].sort()).toEqual(['OtherInFile', 'RemoteClient'])
    for (const module of [
      'node:https',
      'http',
      'undici',
      'web-push',
      '@aws-sdk/client-s3',
      'nodemailer'
    ]) {
      expect(
        providerRoots(parseClasses('x.ts', `import x from '${module}'\nclass A {}`), []).size
      ).toBe(1)
    }
  })

  it('does not count a type-only import or another module', () => {
    expect(providerRoots(parseClasses('a/t.ts', typeOnly), []).size).toBe(0)
    expect(
      providerRoots(parseClasses('a/u.ts', `import { z } from 'zod'\nclass A {}`), []).size
    ).toBe(0)
  })

  it('flags a route that reaches such a class', () => {
    expect(reach(CLIENT, '@Get() list() { return this.remote.get() }')).toEqual(['a/c.ts#C.list'])
  })

  it('does not count an inline type specifier, and counts a default, namespace or mixed import', () => {
    const size = (code: string): number =>
      providerRoots(parseClasses('x.ts', `${code}\nclass A {}`), []).size
    expect(size(`import { type AxiosInstance } from 'axios'`)).toBe(0)
    expect(size(`import { createServer, type IncomingMessage } from 'node:http'`)).toBe(1)
    expect(size(`import * as https from 'node:https'`)).toBe(1)
    expect(size(`import axios from 'axios'`)).toBe(1)
    expect(size(`import 'undici'`)).toBe(1)
  })

  it('flags the routes of a controller whose file imports a network module itself', () => {
    const classes = parseClasses(
      'a/c.ts',
      `import axios from 'axios'\n@Controller() class C { @Get() list() { return 1 } }`
    )
    expect(unmarkedExternalRoutes(classes, []).map(r => r.key)).toEqual(['a/c.ts#C.list'])
  })
})

describe('renamed imports', () => {
  it('follows a class imported under another name', () => {
    const classes = [
      ...parseClasses(
        'a/core.ts',
        `class PickupsService { make() { return this.storage.put(1) } constructor(private readonly storage: StorageService) {} }`
      ),
      ...parseClasses(
        'a/c.ts',
        `import { PickupsService as CorePickups } from 'x'\n@Controller() class C { constructor(private readonly pickups: CorePickups) {} @Post() go() { return this.pickups.make() } }`
      )
    ]
    expect(unmarkedExternalRoutes(classes, PROVIDERS).map(r => r.key)).toEqual(['a/c.ts#C.go'])
  })
})

describe('free functions that go over the network', () => {
  const FILE = `import { request } from 'node:https'
export function pinnedGet() { return request() }
export const pinnedPost = () => request()
export const LIMIT = 5
function helper() { return 1 }`
  it('names the exported functions of a file that imports a network module', () => {
    expect(networkFunctionsOf('a/p.ts', FILE)).toEqual(['pinnedGet', 'pinnedPost'])
    expect(networkFunctionsOf('a/q.ts', `export function pure() { return 1 }`)).toEqual([])
  })
  it('flags a route whose service calls one of them', () => {
    const service = `class S { go() { return pinnedPost() } }`
    const classes = [
      ...parseClasses('a/s.ts', service, new Set(['pinnedPost'])),
      ...parseClasses(
        'a/c.ts',
        `@Controller() class C { constructor(private readonly s: S) {} @Post() run() { return this.s.go() } }`
      )
    ]
    expect(unmarkedExternalRoutes(classes, []).map(r => r.key)).toEqual(['a/c.ts#C.run'])
    expect(
      unmarkedExternalRoutes([...parseClasses('a/s.ts', service), ...classes.slice(1)], [])
    ).toEqual([])
  })
})

describe('inheritance with renamed imports', () => {
  it('follows a base class imported under another name', () => {
    const base = parseClasses(
      'a/base.ts',
      `class PickupsService { constructor(protected readonly storage: StorageService) {} protected make() { return this.storage.put(1) } }`
    )
    const child = parseClasses(
      'a/c.ts',
      `import { PickupsService as CorePickups } from 'x'\n@Controller() class C extends CorePickups { @Post() go() { return this.make() } }`
    )
    expect(unmarkedExternalRoutes([...base, ...child], PROVIDERS).map(r => r.key)).toEqual([
      'a/c.ts#C.go'
    ])
  })
})

describe('unknown field types', () => {
  it('sees a called field declared in a base class, and a qualified type', () => {
    const classes = [
      ...parseClasses(
        'a/b.ts',
        `class Base { constructor(protected readonly sdk: vendor.Client) {} }`
      ),
      ...parseClasses('a/c.ts', `class Child extends Base { run() { this.sdk.upload() } }`)
    ]
    expect(unknownFieldTypes(classes, [], [])).toEqual(['vendor.Client'])
  })
  it('reports a pure type that nothing calls, even when a field has the type', () => {
    const classes = parseClasses('a/h.ts', `class H { constructor(private readonly q: Queue) {} }`)
    expect(stalePureTypes(classes, ['Queue'])).toEqual(['Queue'])
  })
  const classes = parseClasses(
    'a/s.ts',
    `class S { constructor(private readonly a: Mystery, private readonly b: Known, private readonly c: Sender) {} run() { this.a.go(); this.b.go(); this.c.sendMessage() } }`
  )
  it('lists a called type that is not a class, a provider or a pure type', () => {
    expect(unknownFieldTypes(classes, [], [])).toEqual(['Known', 'Mystery'])
  })
  it('lets a provider or a pure type through, and a network method needs no list', () => {
    expect(unknownFieldTypes(classes, [{ name: 'Mystery', reason: 'r' }], ['Known'])).toEqual([])
  })
  it('reports a pure type that no field has', () => {
    expect(stalePureTypes(classes, ['Known', 'Gone'])).toEqual(['Gone'])
  })
  it('accepts a provider that is a library type used by a field', () => {
    expect(unknownProviders(classes, [{ name: 'Mystery', reason: 'r' }])).toEqual([])
  })
})

describe('baseline helpers', () => {
  const route = (key: string) => ({ key, file: 'f', line: 1, why: 'w' })
  it('tells new, fixed and grown entries', () => {
    expect(newlyUnmarked(['a'], [route('a'), route('b')]).map(r => r.key)).toEqual(['b'])
    expect(fixedEntries(['a', 'b'], [route('a')])).toEqual(['b'])
    expect(baselineGrowth(['a'], ['a', 'c'])).toEqual(['c'])
  })
  it('reports a provider that no class has', () => {
    expect(
      unknownProviders(parseClasses('x.ts', SERVICE), [{ name: 'Gone', reason: 'r' }])
    ).toEqual(['Gone'])
  })
})

describe('local methods of a provider', () => {
  const service = `
class SignedService {
  constructor(private readonly storage: StorageService) {}
  sign(id: string) { return this.storage.downloadUrl(id) }
  signThenHead(id: string) { return this.storage.downloadUrl(id).then(() => this.storage.head(id)) }
  head(id: string) { return this.storage.head(id) }
}
`
  const controllerOf = (method: string) => `
@Controller('files')
class SignedController {
  constructor(private readonly signed: SignedService) {}
  @Get('x')
  read() { return this.signed.${method}('1') }
}
`
  const keys = (
    method: string,
    providers: Parameters<typeof unmarkedExternalRoutes>[1]
  ): string[] =>
    unmarkedExternalRoutes(
      [
        ...parseClasses('a/signed.service.ts', service),
        ...parseClasses('a/signed.controller.ts', controllerOf(method))
      ],
      providers
    ).map(r => r.key)
  const LOCAL = [{ name: 'StorageService', reason: 'the bucket', localMethods: ['downloadUrl'] }]
  const ALL = [{ name: 'StorageService', reason: 'the bucket' }]

  it('flags a call to any method of the provider when none is declared local', () => {
    expect(keys('sign', ALL)).toEqual(['a/signed.controller.ts#SignedController.read'])
  })

  it('does not flag a route that only calls a method declared local', () => {
    expect(keys('sign', LOCAL)).toEqual([])
  })

  it('still flags a route that also calls a method that is not local', () => {
    expect(keys('signThenHead', LOCAL)).toEqual(['a/signed.controller.ts#SignedController.read'])
    expect(keys('head', LOCAL)).toEqual(['a/signed.controller.ts#SignedController.read'])
  })
})

describe('the local methods that providers declare', () => {
  const provider = (body: string) => parseClasses('a/store.ts', `class StoreService {\n${body}\n}`)
  const LOCAL = [{ name: 'StoreService', reason: 'x', localMethods: ['sign'] }]

  it('accepts a method that computes and calls nothing of its class', () => {
    expect(localMethodProblems(provider('sign(id: string) { return makeUrl(id) }'), LOCAL)).toEqual(
      []
    )
  })

  it('refuses a name that is not a method of the class', () => {
    expect(localMethodProblems(provider('other() { return 1 }'), LOCAL)).toEqual([
      'StoreService.sign: declared local but the class has no such method'
    ])
  })

  it('refuses a local method that calls a method of its class that is not local', () => {
    expect(
      localMethodProblems(
        provider('sign(id: string) { return this.head(id) }\nhead(id: string) { return 1 }'),
        LOCAL
      )
    ).toEqual(['StoreService.sign: declared local but it calls this.head(), which is not'])
  })

  it('refuses a local method that goes over the network, and a class that is not in the scan', () => {
    expect(localMethodProblems(provider('sign(id: string) { return fetch(id) }'), LOCAL)).toEqual([
      'StoreService.sign: declared local but it goes over the network'
    ])
    expect(localMethodProblems([], LOCAL)).toEqual([
      'StoreService: localMethods needs the class of the provider in the scan'
    ])
  })

  it('refuses a provider that is listed twice', () => {
    expect(
      localMethodProblems(provider('sign(id: string) { return 1 }'), [...LOCAL, ...LOCAL])
    ).toEqual(['StoreService is listed twice'])
  })

  it('declares exactly the two signers of the bucket, which keeps static credentials', () => {
    const storage = EXTERNAL_IO_PROVIDERS.find(entry => entry.name === 'StorageService')
    expect(storage?.localMethods).toEqual(['uploadUrl', 'downloadUrl'])
    const module = readFileSync(
      join(__dirname, '../../libs/core/storage/src/storage.module.ts'),
      'utf8'
    )
    expect(module).toMatch(/credentials:\s*\{\s*accessKeyId/)
    expect(module).toMatch(/region:/)
  })
})
