/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ApiError, DSR_PUBLIC_TYPES, type DsrRequestInput } from '@platform/api-client'

import en from '../../messages/en.json'
import es from '../../messages/es.json'

import { DsrRequestForm } from './dsr-request-form'

const KEY = 'k'.repeat(32)

const mockSubmit = jest.fn<Promise<{ accepted: true }>, [unknown, DsrRequestInput]>()
jest.mock('@platform/api-client', () => ({
  ...jest.requireActual<object>('@platform/api-client'),
  submitDsrRequest: (client: unknown, input: DsrRequestInput): Promise<{ accepted: true }> =>
    mockSubmit(client, input)
}))
jest.mock('../../lib/api', () => ({ apiClient: { marker: 'client' } }))
// The texts are the keys: the words are checked by the messages specs of both languages
jest.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'es'
}))

function openWith(hash: string): void {
  window.history.replaceState(null, '', `/compliance/dsr/request${hash}`)
}

function fill(email: string): void {
  fireEvent.change(screen.getByLabelText('emailLabel'), { target: { value: email } })
}

describe('the public form of data requests', () => {
  beforeEach(() => {
    mockSubmit.mockReset()
    mockSubmit.mockResolvedValue({ accepted: true })
  })

  it('sends exactly the body of the api (key, kind, address, language) and takes the key out of the address bar', async () => {
    openWith(`#key=${KEY}`)
    render(<DsrRequestForm />)
    fireEvent.change(screen.getByLabelText('typeLabel'), { target: { value: 'erasure' } })
    fill('  Ana@Example.com ')
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await waitFor(() => expect(screen.getByText('sent')).toBeTruthy())
    expect(mockSubmit).toHaveBeenCalledTimes(1)
    expect(mockSubmit).toHaveBeenCalledWith(
      { marker: 'client' },
      { storeKey: KEY, type: 'erasure', email: 'Ana@Example.com', locale: 'es' }
    )
    expect(window.location.hash).toBe('')
    // The result is in a live region mounted with its content, and the focus goes to it
    expect(screen.getByRole('status').textContent).toContain('sent')
    expect(document.activeElement?.textContent).toBe('sentTitle')
  })

  it('offers only the kinds the public form takes', () => {
    openWith(`#key=${KEY}`)
    render(<DsrRequestForm />)
    const options = [...screen.getByLabelText('typeLabel').querySelectorAll('option')].map(
      option => option.value
    )
    expect(options).toEqual(['access', 'erasure', 'portability'])
  })

  it.each(['', '#', '#other=1', '#key=', '#key=short', `#key=${'k'.repeat(129)}`])(
    'shows no form and sends nothing when the address carries no usable key (%j)',
    hash => {
      openWith(hash)
      render(<DsrRequestForm />)
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.queryByLabelText('emailLabel')).toBeNull()
      expect(screen.getByRole('alert').textContent).toBe('incomplete')
      expect(mockSubmit).not.toHaveBeenCalled()
    }
  )

  it.each(['', 'not-an-address', 'a@b'])(
    'does not send an address that is not one (%j) and puts the focus on the field with its message',
    async address => {
      openWith(`#key=${KEY}`)
      render(<DsrRequestForm />)
      fill(address)
      fireEvent.click(screen.getByRole('button', { name: 'submit' }))
      const field = screen.getByLabelText('emailLabel')
      await waitFor(() => expect(document.activeElement).toBe(field))
      expect(field.getAttribute('aria-invalid')).toBe('true')
      const described = field.getAttribute('aria-describedby')
      expect(document.getElementById(described ?? '')?.textContent).toBe('emailInvalid')
      expect(mockSubmit).not.toHaveBeenCalled()
    }
  )

  it('says the same thing whatever the address is: it branches on the status only', async () => {
    openWith(`#key=${KEY}`)
    const first = render(<DsrRequestForm />)
    fill('customer@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await waitFor(() => expect(screen.getByText('sent')).toBeTruthy())
    const html = first.container.innerHTML
    first.unmount()

    openWith(`#key=${KEY}`)
    const second = render(<DsrRequestForm />)
    fill('nobody@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await waitFor(() => expect(screen.getByText('sent')).toBeTruthy())
    expect(second.container.innerHTML).toBe(html)
  })

  it('keeps what was typed, the key and the button when the server could not be reached, and offers to try again', async () => {
    openWith(`#key=${KEY}`)
    mockSubmit.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'offline'))
    render(<DsrRequestForm />)
    fill('ana@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('failed'))
    expect(screen.getByLabelText<HTMLInputElement>('emailLabel').value).toBe('ana@example.com')
    expect(window.location.hash).toBe(`#key=${KEY}`)
    // The focus goes to the message, and the button now says what pressing it does
    expect(document.activeElement?.textContent).toBe('failed')
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await waitFor(() => expect(screen.getByText('sent')).toBeTruthy())
    expect(mockSubmit).toHaveBeenCalledTimes(2)
  })

  it('says one thing for a 429, with no wait time that would tell which limit was hit', async () => {
    openWith(`#key=${KEY}`)
    mockSubmit.mockRejectedValueOnce(
      new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'slow', null, { retryAfterSeconds: 86_400 })
    )
    render(<DsrRequestForm />)
    fill('ana@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('tooMany'))
    expect(document.activeElement?.textContent).toBe('tooMany')
  })

  it('ignores a second press while it works and keeps the button in the tab order (aria-disabled, never disabled)', async () => {
    openWith(`#key=${KEY}`)
    let finish: (value: { accepted: true }) => void = () => undefined
    mockSubmit.mockReturnValueOnce(new Promise(resolve => (finish = resolve)))
    render(<DsrRequestForm />)
    fill('ana@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    const working = screen.getByRole('button', { name: 'working' })
    expect(working.getAttribute('aria-disabled')).toBe('true')
    expect(working.hasAttribute('disabled')).toBe(false)
    fireEvent.click(working)
    expect(mockSubmit).toHaveBeenCalledTimes(1)
    finish({ accepted: true })
    await waitFor(() => expect(screen.getByText('sent')).toBeTruthy())
  })

  it('keeps the form and what was typed when the api refuses a body that looked good (it says nothing about the key)', async () => {
    openWith(`#key=${KEY}`)
    mockSubmit.mockRejectedValueOnce(new ApiError(400, 'VALIDATION_FAILED', 'invalid'))
    render(<DsrRequestForm />)
    fill('ana@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'submit' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('failed'))
    expect(screen.getByLabelText<HTMLInputElement>('emailLabel').value).toBe('ana@example.com')
  })

  it('brings the focus back to the field on a second press with the same bad address', () => {
    openWith(`#key=${KEY}`)
    render(<DsrRequestForm />)
    fill('bad')
    const submit = screen.getByRole('button', { name: 'submit' })
    fireEvent.click(submit)
    submit.focus()
    fireEvent.click(submit)
    expect(document.activeElement).toBe(screen.getByLabelText('emailLabel'))
  })

  it.each([['en'], ['es']])('has a text in %s for every kind the form offers', language => {
    const messages = (language === 'en' ? en : es) as {
      dsrRequest: { types: Record<string, string> }
    }
    for (const kind of DSR_PUBLIC_TYPES) expect(messages.dsrRequest.types[kind]).toBeTruthy()
  })
})
