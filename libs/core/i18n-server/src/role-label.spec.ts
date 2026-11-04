import { RoleNames } from '@platform/core/auth'
import { Locales } from '@platform/core/i18n'

import { roleLabelOf } from './role-label'

describe('roleLabelOf', () => {
  it('has a name for every system role in every language', () => {
    for (const locale of [Locales.ES, Locales.EN]) {
      for (const name of Object.values(RoleNames)) {
        expect(roleLabelOf(locale, name)).not.toBe('')
      }
    }
    expect(roleLabelOf(Locales.ES, RoleNames.ADMIN)).not.toBe(RoleNames.ADMIN)
  })

  it('names the system roles in the language asked', () => {
    expect(roleLabelOf(Locales.ES, 'Agent')).toBe('Agente')
    expect(roleLabelOf(Locales.ES, 'Viewer')).toBe('Solo lectura')
    expect(roleLabelOf(Locales.ES, 'Admin')).toBe('Administrador')
    expect(roleLabelOf(Locales.EN, 'Viewer')).toBe('Viewer')
  })

  it('keeps the name of a role the store made, whatever it is', () => {
    expect(roleLabelOf(Locales.ES, 'Atención VIP')).toBe('Atención VIP')
    expect(roleLabelOf(Locales.ES, 'toString')).toBe('toString')
    expect(roleLabelOf(Locales.ES, '__proto__')).toBe('__proto__')
  })
})
