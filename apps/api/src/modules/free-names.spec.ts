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
