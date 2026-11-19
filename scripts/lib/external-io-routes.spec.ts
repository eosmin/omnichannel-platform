import {
  baselineGrowth,
  fixedEntries,
  newlyUnmarked,
  parseClasses,
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
