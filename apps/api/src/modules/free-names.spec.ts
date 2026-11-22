import { putConnectionSchema } from './channels/plugin-channel.schemas'
import { createAddressSchema } from './customers/customers.schemas'
import { acceptInvitationSchema } from './invitations/invitations.schemas'
import { requestAvatarUploadSchema } from './media/avatar.schemas'
import { updateOrganizationSchema } from './organizations/organizations.schemas'

// The names a person types or a provider reports are one visible line (QA round 2, TRX-04 and the rest of the free names)
const BREAK = 'Ana\nSmith'
const SEPARATOR = 'Ana Smith'
const DIRECTION = 'Ana‮smith'

describe('free names that are shown in lists', () => {
  describe('typed by a person: refused when they hide a line or a direction', () => {
    it.each([BREAK, SEPARATOR, DIRECTION])('the name of an organization refuses %j', name => {
      expect(updateOrganizationSchema.safeParse({ name }).success).toBe(false)
    })

    it('the name of an organization is trimmed and kept as one line', () => {
      expect(updateOrganizationSchema.parse({ name: '  Acme  Co  ' })).toEqual({
        name: 'Acme Co'
      })
    })

    it.each([BREAK, SEPARATOR, DIRECTION])('the name on an invitation refuses %j', name => {
      expect(acceptInvitationSchema.safeParse({ name }).success).toBe(false)
    })

    it.each([BREAK, SEPARATOR, DIRECTION])('the label of a plugin connection refuses %j', name => {
      expect(putConnectionSchema.safeParse({ displayName: name }).success).toBe(false)
    })

    it.each(['label', 'line1', 'line2', 'city', 'state', 'postalCode'] as const)(
      'the address field %s refuses a line break',
      field => {
        const address = {
          label: 'Home',
          line1: 'Calle 1',
          line2: 'Apt 2',
          city: 'San Salvador',
          state: 'SS',
          postalCode: '1101',
          country: 'sv',
          isDefault: false
        }
        expect(createAddressSchema.safeParse(address).success).toBe(true)
        expect(createAddressSchema.safeParse({ ...address, [field]: BREAK }).success).toBe(false)
      }
    )

    describe('a name with nothing readable in it', () => {
      const address = {
        label: 'Home',
        line1: 'Calle 1',
        line2: 'Apt 2',
        city: 'San Salvador',
        state: 'SS',
        postalCode: '1101',
        country: 'sv',
        isDefault: false
      }
      const parsers: Record<string, (name: string) => boolean> = {
        organization: name => updateOrganizationSchema.safeParse({ name }).success,
        invitation: name => acceptInvitationSchema.safeParse({ name }).success,
        'plugin connection': name => putConnectionSchema.safeParse({ displayName: name }).success,
        'address line': name => createAddressSchema.safeParse({ ...address, line1: name }).success,
        'avatar file': name =>
          requestAvatarUploadSchema.safeParse({
            filename: name,
            contentType: 'image/png',
            fileSizeBytes: 10
          }).success
      }

      it.each(Object.keys(parsers))('%s: only spaces is refused', field => {
        expect(parsers[field]?.('   ')).toBe(field === 'avatar file')
      })

      it.each(Object.keys(parsers))(
        '%s: only invisible or control characters is refused',
        field => {
          // A file name only refuses controls, line breaks and direction overrides: the key is sanitized anyway
          expect(parsers[field]?.('\u200B\u200B')).toBe(field === 'avatar file')
          expect(parsers[field]?.('\u0007')).toBe(false)
        }
      )

      it.each(Object.keys(parsers))('%s: only an emoji is a name', field => {
        expect(parsers[field]?.('\u{1F600}')).toBe(true)
      })

      it.each(Object.keys(parsers))('%s: a name with a joiner and an emoji is kept', field => {
        expect(parsers[field]?.('Casa \u{1F468}\u200D\u{1F469}\u200D\u{1F467}')).toBe(true)
      })
    })

    it.each([
      ['a line break', 'a\nb.png'],
      ['a NUL', 'a\0b.png'],
      ['a direction override', 'a‮gnp.exe']
    ])('the name of an uploaded avatar refuses %s', (_label, filename) => {
      const body = { filename, contentType: 'image/png', fileSizeBytes: 10 }
      expect(requestAvatarUploadSchema.safeParse(body).success).toBe(false)
      expect(requestAvatarUploadSchema.safeParse({ ...body, filename: 'año.png' }).success).toBe(
        true
      )
    })
  })
})
