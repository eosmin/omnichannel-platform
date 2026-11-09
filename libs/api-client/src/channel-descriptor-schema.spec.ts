import {
  channelDescriptorSchema,
  channelDirectorySchema,
  channelOAuthDescriptorSchema
} from './api-schemas'

const valid = {
  displayName: { es: 'Acme', en: 'Acme' },
  iconKey: 'phone',
  anonymousCustomers: false,
  managementSurface: null,
  helpSteps: []
}

describe('channelDescriptorSchema', () => {
  it('keeps a valid descriptor', () => {
    expect(channelDescriptorSchema.parse(valid)).toEqual(valid)
  })

  it('falls back to the generic icon, no surface and no help for what it does not know', () => {
    const parsed = channelDescriptorSchema.parse({
      ...valid,
      iconKey: 'skull',
      managementSurface: 'iframe',
      helpSteps: [{ es: '<b>x</b>', en: 'x' }]
    })
    expect(parsed).toMatchObject({
      iconKey: 'message-square',
      managementSurface: null,
      helpSteps: []
    })
  })

  it('refuses a name that is not plain text', () => {
    for (const es of ['<b>x</b>', 'evil.com', '⠀', 'a'.repeat(5_000_000)]) {
      expect(
        channelDescriptorSchema.safeParse({ ...valid, displayName: { es, en: 'x' } }).success
      ).toBe(false)
    }
  })

  it('never makes the whole directory fail for one bad descriptor', () => {
    const entry = {
      id: 'a',
      pluginId: 'p',
      pluginName: 'P',
      displayName: 'x',
      status: 'active',
      capabilities: []
    }
    const list = channelDirectorySchema.parse([
      { ...entry, descriptor: { ...valid, displayName: { es: '<x>', en: 'x' } } },
      { ...entry, id: 'b', descriptor: valid }
    ])
    expect(list[0]?.descriptor).toBeNull()
    expect(list[1]?.descriptor?.displayName.es).toBe('Acme')
  })
})

describe('channelOAuthDescriptorSchema', () => {
  const login = {
    dialogOrigin: 'https://login.acme.test',
    providerName: { es: 'Acme', en: 'Acme' },
    linkedAccount: null,
    assetIdPattern: '^\\d{1,32}$'
  }

  it('keeps a valid login', () => {
    expect(channelOAuthDescriptorSchema.parse(login)).toEqual(login)
  })

  it('refuses an address that is more than the origin of a site, and a pattern that can backtrack', () => {
    for (const bad of [
      { dialogOrigin: 'https://login.acme.test/x' },
      { dialogOrigin: 'http://login.acme.test' },
      { dialogOrigin: 'https://u:p@login.acme.test' },
      { assetIdPattern: '^(a+)+$' }
    ]) {
      expect(channelOAuthDescriptorSchema.safeParse({ ...login, ...bad }).success).toBe(false)
    }
  })
})
