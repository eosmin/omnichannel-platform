/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ApiError } from '@platform/api-client'

import { DsrVerifyCard } from './dsr-verify-card'

const TOKEN = 'A'.repeat(43)

const mockVerify = jest.fn<Promise<{ verified: true }>, [unknown, string]>()
jest.mock('@platform/api-client', () => ({
  ...jest.requireActual<object>('@platform/api-client'),
  verifyDsrRequest: (client: unknown, token: string): Promise<{ verified: true }> =>
    mockVerify(client, token)
}))
jest.mock('../../lib/api', () => ({ apiClient: { marker: 'client' } }))
// The texts are the keys: the words are checked by the messages specs of both languages
jest.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key
}))

function openWith(hash: string): void {
  window.history.replaceState(null, '', `/compliance/dsr/verify${hash}`)
}

describe('the page that confirms a data request', () => {
  beforeEach(() => {
    mockVerify.mockReset()
    mockVerify.mockResolvedValue({ verified: true })
  })

  it('does NOTHING on opening: the single use of the token is spent only by the button (a mail scanner opens links)', () => {
    openWith(`#token=${TOKEN}`)
    render(<DsrVerifyCard />)
    expect(screen.getByRole('button', { name: 'confirm' })).toBeTruthy()
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('sends the token of the fragment once the button is pressed, clears the address, and says the request was confirmed', async () => {
    openWith(`#token=${TOKEN}`)
    render(<DsrVerifyCard />)
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }))
    await waitFor(() => expect(screen.getByText('done')).toBeTruthy())
    expect(mockVerify).toHaveBeenCalledTimes(1)
    expect(mockVerify).toHaveBeenCalledWith({ marker: 'client' }, TOKEN)
    expect(window.location.hash).toBe('')
    // The result is in a live region and holds the focus: the button that was pressed is gone
    expect(screen.getByRole('status')).toBeTruthy()
    expect(document.activeElement?.textContent).toBe('doneTitle')
  })

  it.each(['', '#', '#other=1', '#token=', '#token=abc', `#token=${'+'.repeat(43)}`])(
    'has no button and sends nothing when the address carries no token (%j)',
    hash => {
      openWith(hash)
      render(<DsrVerifyCard />)
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.getByRole('alert').textContent).toBe('invalid')
      expect(mockVerify).not.toHaveBeenCalled()
    }
  )

  it('says one thing for a token that does not hold, takes it out of the address and offers no second press', async () => {
    openWith(`#token=${TOKEN}`)
    mockVerify.mockRejectedValueOnce(
      new ApiError(
        400,
        'DSR_VERIFICATION_INVALID',
        'the verification of the data request is not valid'
      )
    )
    render(<DsrVerifyCard />)
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('invalid'))
    expect(screen.queryByRole('button')).toBeNull()
    expect(window.location.hash).toBe('')
    expect(mockVerify).toHaveBeenCalledTimes(1)
  })

  it('keeps the button and the token for a 400 that is not the refusal of the api (a gateway)', async () => {
    openWith(`#token=${TOKEN}`)
    mockVerify.mockRejectedValueOnce(new ApiError(400, 'BAD_GATEWAY_REQUEST', 'rejected upstream'))
    render(<DsrVerifyCard />)
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('failed'))
    expect(screen.getByRole('button', { name: 'retry' })).toBeTruthy()
    expect(window.location.hash).toBe(`#token=${TOKEN}`)
    // The focus goes to the message that says what happened
    expect(document.activeElement?.textContent).toBe('failed')
  })

  it('ignores a second press while it works and keeps the button in the tab order (aria-disabled, never disabled)', async () => {
    openWith(`#token=${TOKEN}`)
    let finish: (value: { verified: true }) => void = () => undefined
    mockVerify.mockReturnValueOnce(new Promise(resolve => (finish = resolve)))
    render(<DsrVerifyCard />)
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }))
    const working = screen.getByRole('button', { name: 'working' })
    expect(working.getAttribute('aria-disabled')).toBe('true')
    expect(working.hasAttribute('disabled')).toBe(false)
    fireEvent.click(working)
    expect(mockVerify).toHaveBeenCalledTimes(1)
    finish({ verified: true })
    await waitFor(() => expect(screen.getByText('done')).toBeTruthy())
  })

  it('says so and keeps the button when the server could not be reached, and when it asks to wait', async () => {
    openWith(`#token=${TOKEN}`)
    mockVerify.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'offline'))
    render(<DsrVerifyCard />)
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('failed'))

    mockVerify.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'slow'))
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('tooMany'))
    expect(screen.getByRole('button', { name: 'retry' })).toBeTruthy()
    expect(document.activeElement?.textContent).toBe('tooMany')
    // The token stays in the address while the person can still try again
    expect(window.location.hash).toBe(`#token=${TOKEN}`)
  })
})
