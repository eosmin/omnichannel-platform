import { channelDescriptorSchema, channelDirectorySchema } from './api-schemas'

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
