/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react'

import { PermissionDenied } from './states'

const TEXTS: Record<string, string> = {
  'settings.team.permissions.inventory.view': 'Ver inventario',
  'settings.team.permissions.purchases.view': 'Ver compras',
  'permissionDenied.named': 'named:{permission}',
  'permissionDenied.oneOf': 'oneOf:{permissions}',
  'emptyStates.permissionDenied.title': 'title',
  'emptyStates.permissionDenied.body': 'plain body'
}

// A translator over the texts above: `{name}` is filled from the values, and a scoped one reads the keys under its scope
jest.mock('next-intl', () => {
  const translatorOf =
    (scope: string) =>
    (key: string, values?: Record<string, string>): string => {
      const text = TEXTS[scope === '' ? key : `${scope}.${key}`] ?? `[${key}]`
      return text.replace(/\{(\w+)\}/g, (_match, name: string) => values?.[name] ?? '')
    }
  return {
    useTranslations: (scope = ''): unknown =>
      Object.assign(translatorOf(scope), {
        has: (key: string) => (scope === '' ? key : `${scope}.${key}`) in TEXTS
      }),
    useFormatter: () => ({ list: (items: string[]) => items.join(' y ') })
  }
})

describe('PermissionDenied', () => {
  it('names the one permission that is missing, not "one of these", when the page opens with a single one', () => {
    render(<PermissionDenied anyOf={['inventory:view']} />)
    expect(screen.getByText('named:Ver inventario')).toBeTruthy()
  })

  it('lists the permissions when any of two or more opens the page', () => {
    render(<PermissionDenied anyOf={['inventory:view', 'purchases:view']} />)
    expect(screen.getByText('oneOf:Ver inventario y Ver compras')).toBeTruthy()
  })

  it('keeps the plain text when no permission has a name', () => {
    render(<PermissionDenied anyOf={['unknown:thing']} />)
    expect(screen.getByText('plain body')).toBeTruthy()
  })
})
