/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ApiError } from '@platform/api-client'

import { UnsubscribeCard } from './unsubscribe-card'

const mockUnsubscribe = jest.fn<Promise<undefined>, [unknown, string]>()
jest.mock('@platform/api-client', () => ({
  ...jest.requireActual<object>('@platform/api-client'),
  unsubscribeFromNotificationEmails: (client: unknown, token: string): Promise<undefined> =>
    mockUnsubscribe(client, token)
}))
jest.mock('../../lib/api', () => ({ apiClient: { marker: 'client' } }))
// The texts are the keys: the words are checked by the messages specs of both languages
jest.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key
}))

function openWith(hash: string): void {
  window.history.replaceState(null, '', `/unsubscribe${hash}`)
}

describe('the page of the one-click unsubscribe', () => {
  beforeEach(() => {
    mockUnsubscribe.mockReset()
    mockUnsubscribe.mockResolvedValue(undefined)
  })

  it('does NOTHING on opening: the change is made only by the button (a mail scanner opens links)', () => {
    openWith('#token=v1.ne.abc.mac')
    render(<UnsubscribeCard />)
    expect(screen.getByRole('button', { name: 'confirm' })).toBeTruthy()
    expect(mockUnsubscribe).not.toHaveBeenCalled()
  })

  it('POSTs the token of the fragment once the button is pressed, then clears the address and says done', async () => {
    openWith('#token=v1.ne.abc.mac')
    render(<UnsubscribeCard />)
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }))
    await waitFor(() => expect(screen.getByText('done')).toBeTruthy())
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
    expect(mockUnsubscribe).toHaveBeenCalledWith({ marker: 'client' }, 'v1.ne.abc.mac')
    expect(window.location.hash).toBe('')
  })

  it('has no button and sends nothing when the address carries no token', () => {
    openWith('')
    render(<UnsubscribeCard />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('invalid')
    expect(mockUnsubscribe).not.toHaveBeenCalled()
  })

  it('says so and keeps the button when the server could not be reached, and when it asks to wait', async () => {
    openWith('#token=v1.ne.abc.mac')
    mockUnsubscribe.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'offline'))
    render(<UnsubscribeCard />)
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('failed'))

    mockUnsubscribe.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'slow'))
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('tooMany'))
    expect(screen.getByRole('button', { name: 'confirm' })).toBeTruthy()
  })
})
