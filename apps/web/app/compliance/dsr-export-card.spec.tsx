/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ApiError, type DsrExportDownloadResult } from '@platform/api-client'

import { DsrExportCard } from './dsr-export-card'

const TOKEN = 'A'.repeat(43)
const ANSWER: DsrExportDownloadResult = {
  url: 'https://files.example.com/signed?sig=abc',
  filename: 'data-export.zip',
  expiresInSeconds: 300,
  password: 'correct-horse-battery'
}

const mockDownload = jest.fn<Promise<DsrExportDownloadResult>, [unknown, string]>()
jest.mock('@platform/api-client', () => ({
  ...jest.requireActual<object>('@platform/api-client'),
  downloadDsrExport: (client: unknown, token: string): Promise<DsrExportDownloadResult> =>
    mockDownload(client, token)
}))
jest.mock('../../lib/api', () => ({ apiClient: { marker: 'client' } }))
// The texts are the keys: the words are checked by the messages specs of both languages
jest.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key
}))

const clickSpy = jest
  .spyOn(HTMLAnchorElement.prototype, 'click')
  .mockImplementation(() => undefined)

function openWith(hash: string): void {
  window.history.replaceState(null, '', `/compliance/dsr/export${hash}`)
}

describe('the page that hands over the file of a data export', () => {
  beforeEach(() => {
    mockDownload.mockReset()
    mockDownload.mockResolvedValue(ANSWER)
    clickSpy.mockClear()
  })

  it('does NOTHING on opening: the single use of the token is spent only by the button (a mail scanner opens links)', () => {
    openWith(`#token=${TOKEN}`)
    render(<DsrExportCard />)
    expect(screen.getByRole('button', { name: 'download' })).toBeTruthy()
    expect(mockDownload).not.toHaveBeenCalled()
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('sends the token once the button is pressed, clears the address, starts the download and offers the link', async () => {
    openWith(`#token=${TOKEN}`)
    render(<DsrExportCard />)
    fireEvent.click(screen.getByRole('button', { name: 'download' }))
    await waitFor(() => expect(screen.getByText('doneTitle')).toBeTruthy())
    expect(mockDownload).toHaveBeenCalledWith({ marker: 'client' }, TOKEN)
    expect(window.location.hash).toBe('')
    expect(clickSpy).toHaveBeenCalledTimes(1)
    const link = screen.getByRole('link', { name: 'again' })
    expect(link.getAttribute('href')).toBe(ANSWER.url)
    expect(link.getAttribute('rel')).toBe('noreferrer noopener')
    expect(document.activeElement?.textContent).toBe('doneTitle')
  })

  it('shows the password once, copies it on request, and keeps it out of the address and the storage', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    openWith(`#token=${TOKEN}`)
    render(<DsrExportCard />)
    fireEvent.click(screen.getByRole('button', { name: 'download' }))
    await waitFor(() => expect(screen.getByText(ANSWER.password)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ANSWER.password))
    await waitFor(() => expect(screen.getAllByText('copied').length).toBeGreaterThan(0))
    expect(window.location.href).not.toContain(ANSWER.password)
    expect(JSON.stringify(window.localStorage)).not.toContain(ANSWER.password)
    expect(JSON.stringify(window.sessionStorage)).not.toContain(ANSWER.password)
  })

  it('says so when the password could not be copied', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: jest.fn().mockRejectedValue(new Error('denied')) },
      configurable: true
    })
    openWith(`#token=${TOKEN}`)
    render(<DsrExportCard />)
    fireEvent.click(screen.getByRole('button', { name: 'download' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'copy' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'copy' }))
    await waitFor(() => expect(screen.getByText('copyFailed')).toBeTruthy())
  })

  it('does not present a success when the answer was refused for carrying no password: the file could not be opened', async () => {
    // The api client throws (not an ApiError) when the answer does not fit its schema, which now requires the password
    mockDownload.mockRejectedValueOnce(new Error('the answer carries no password'))
    openWith(`#token=${TOKEN}`)
    render(<DsrExportCard />)
    fireEvent.click(screen.getByRole('button', { name: 'download' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.queryByText('doneTitle')).toBeNull()
    expect(screen.queryByRole('button', { name: 'copy' })).toBeNull()
  })

  it('withdraws the link when the signed address expires but KEEPS the password (it opens the file already saved)', async () => {
    jest.useFakeTimers()
    try {
      openWith(`#token=${TOKEN}`)
      render(<DsrExportCard />)
      fireEvent.click(screen.getByRole('button', { name: 'download' }))
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByRole('link', { name: 'again' })).toBeTruthy()
      act(() => {
        jest.advanceTimersByTime(ANSWER.expiresInSeconds * 1000)
      })
      expect(screen.queryByRole('link')).toBeNull()
      expect(screen.getByText('expired')).toBeTruthy()
      expect(screen.getByText(ANSWER.password)).toBeTruthy()
      expect(clickSpy).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('never lets a huge lifetime fire the timer at once (a browser timer holds 2^31 - 1 ms)', async () => {
    jest.useFakeTimers()
    try {
      mockDownload.mockResolvedValueOnce({ ...ANSWER, expiresInSeconds: 3_000_000 })
      openWith(`#token=${TOKEN}`)
      render(<DsrExportCard />)
      fireEvent.click(screen.getByRole('button', { name: 'download' }))
      await act(async () => {
        await Promise.resolve()
      })
      act(() => {
        jest.advanceTimersByTime(1000)
      })
      expect(screen.getByRole('link', { name: 'again' })).toBeTruthy()
    } finally {
      jest.useRealTimers()
    }
  })

  it('says it could not copy when the browser has no clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    openWith(`#token=${TOKEN}`)
    render(<DsrExportCard />)
    fireEvent.click(screen.getByRole('button', { name: 'download' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'copy' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'copy' }))
    expect(screen.getByText('copyFailed')).toBeTruthy()
  })

  it.each(['', '#', '#other=1', '#token=', '#token=abc', `#token=${'+'.repeat(43)}`])(
    'has no button and sends nothing when the address carries no token (%j)',
    hash => {
      openWith(hash)
      render(<DsrExportCard />)
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.getByRole('alert').textContent).toBe('invalid')
      expect(mockDownload).not.toHaveBeenCalled()
    }
  )

  it('says one thing for a link that does not hold, takes the token out of the address and offers no second press', async () => {
    openWith(`#token=${TOKEN}`)
    mockDownload.mockRejectedValueOnce(
      new ApiError(400, 'DSR_EXPORT_LINK_INVALID', 'the link to the data export is not valid')
    )
    render(<DsrExportCard />)
    fireEvent.click(screen.getByRole('button', { name: 'download' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('invalid'))
    expect(screen.queryByRole('button')).toBeNull()
    expect(window.location.hash).toBe('')
    // The button that was pressed is gone: the focus goes to the message
    expect(document.activeElement?.textContent).toBe('invalid')
  })

  it('keeps the button and the token for a 400 that is not the refusal of the api (a gateway)', async () => {
    openWith(`#token=${TOKEN}`)
    mockDownload.mockRejectedValueOnce(
      new ApiError(400, 'BAD_GATEWAY_REQUEST', 'rejected upstream')
    )
    render(<DsrExportCard />)
    fireEvent.click(screen.getByRole('button', { name: 'download' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('failed'))
    expect(screen.getByRole('button', { name: 'retry' })).toBeTruthy()
    expect(window.location.hash).toBe(`#token=${TOKEN}`)
    expect(document.activeElement?.textContent).toBe('failed')
  })

  it('ignores a second press while it works and keeps the button in the tab order (aria-disabled, never disabled)', async () => {
    openWith(`#token=${TOKEN}`)
    let finish: (value: DsrExportDownloadResult) => void = () => undefined
    mockDownload.mockReturnValueOnce(new Promise(resolve => (finish = resolve)))
    render(<DsrExportCard />)
    fireEvent.click(screen.getByRole('button', { name: 'download' }))
    const working = screen.getByRole('button', { name: 'working' })
    expect(working.getAttribute('aria-disabled')).toBe('true')
    expect(working.hasAttribute('disabled')).toBe(false)
    fireEvent.click(working)
    expect(mockDownload).toHaveBeenCalledTimes(1)
    finish(ANSWER)
    await waitFor(() => expect(screen.getByText('doneTitle')).toBeTruthy())
  })

  it('says so and keeps the button when the server could not be reached, and when it asks to wait', async () => {
    openWith(`#token=${TOKEN}`)
    mockDownload.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'offline'))
    render(<DsrExportCard />)
    fireEvent.click(screen.getByRole('button', { name: 'download' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('failed'))

    mockDownload.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'slow'))
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('tooMany'))
    expect(screen.getByRole('button', { name: 'retry' })).toBeTruthy()
    expect(window.location.hash).toBe(`#token=${TOKEN}`)
  })
})
