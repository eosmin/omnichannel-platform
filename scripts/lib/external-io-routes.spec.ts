import {
  baselineGrowth,
  fixedEntries,
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

describe('unknown field types', () => {
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
