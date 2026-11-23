/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react'

import { ClientPermissions } from '@platform/core/auth'

import { OrderLink } from './order-link'

const mockProfile = jest.fn<unknown, []>()
jest.mock('../../lib/use-profile', () => ({ useProfile: (): unknown => mockProfile() }))

const STORE = 'store-a'
const profile = (permissions: string[]): unknown => ({
  isSuccess: true,
  data: { memberships: [{ storeId: STORE, permissions }] }
})

function draw(): void {
  render(
    <OrderLink storeId={STORE} orderId="order-1" fallback={<span>none</span>}>
      open
    </OrderLink>
  )
}

describe('OrderLink', () => {
  it('links to the order of the store for who holds orders:view there', () => {
    mockProfile.mockReturnValue(profile([ClientPermissions.ORDERS_VIEW]))
    draw()
    expect(screen.getByRole('link', { name: 'open' }).getAttribute('href')).toBe(
      `/s/${STORE}/orders/order-1`
    )
  })

  it('draws the fallback and no link for who may not read orders', () => {
    mockProfile.mockReturnValue(profile([ClientPermissions.FINANCE_VIEW]))
    draw()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('none')).toBeTruthy()
  })

  it('draws neither the link nor the fallback while the profile loads', () => {
    mockProfile.mockReturnValue({ isSuccess: false, data: undefined })
    draw()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByText('none')).toBeNull()
  })
})
