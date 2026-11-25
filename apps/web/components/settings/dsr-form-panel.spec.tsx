/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { AppPaths, DSR_REQUEST_FRAGMENT_KEY } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { DsrFormPanel } from './dsr-form-panel'

const KEY = 'k'.repeat(22)
const STORE = '5a1c3d2e-9b7f-4a6d-8c11-2e4f6a8b0c13'

interface FormState {
  isPending: boolean
  isError: boolean
  error: unknown
  data: { key: string | null; open: boolean } | undefined
  refetch: jest.Mock
}
const form: FormState = {
  isPending: false,
  isError: false,
  error: null,
  data: { key: KEY, open: false },
  refetch: jest.fn()
}
const mutateMake = jest.fn<Promise<unknown>, [{ current: string | null }]>()
const mutateRevoke = jest.fn<Promise<unknown>, [{ current: string | null }]>()
type Mutate = (input: { current: string | null }) => Promise<unknown>
const permissions = new Set<string>([ClientPermissions.CUSTOMERS_DSR_MANAGE_FORM])
const toastSuccess = jest.fn<void, [string]>()
const toastError = jest.fn<void, [string]>()
const useDsrFormMock = jest.fn()

jest.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
jest.mock('../providers/store-context', () => ({
  useStore: () => ({ storeId: STORE, can: (permission: string) => permissions.has(permission) })
}))
jest.mock('../../lib/compliance/use-dsr-form', () => ({
  useDsrForm: (...args: unknown[]): FormState => {
    useDsrFormMock(...args)
    return form
  },
  useDsrFormChange: (_storeId: string, kind: 'make' | 'revoke') => ({
    isPending: false,
    mutateAsync: (kind === 'make' ? mutateMake : mutateRevoke) as Mutate
  })
}))
jest.mock('../../lib/toast', () => ({
  toast: {
    success: (text: string): void => toastSuccess(text),
    error: (text: string): void => toastError(text)
  }
}))
jest.mock('../../lib/use-error-text', () => ({
  useErrorText: () => (error: unknown) => `error:${String(error)}`
}))
// The confirmation is a dialog of its own (its own spec): here it confirms at once, and the request it was given is kept
const asked: { title: string; description: string; confirmLabel: string }[] = []
jest.mock('../shared/destructive-action', () => ({
  useDestructiveAction:
    () =>
    (
      _name: string,
      request: {
        title: string
        description: string
        confirmLabel: string
        onConfirm: () => Promise<void>
      }
    ): void => {
      asked.push(request)
      void request.onConfirm()
    }
}))
jest.mock('./copy-button', () => ({
  CopyButton: ({ text }: { text: string }) => <span data-testid="copied-text">{text}</span>
}))

describe('DsrFormPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    asked.length = 0
    permissions.clear()
    permissions.add(ClientPermissions.CUSTOMERS_DSR_MANAGE_FORM)
    form.isPending = false
    form.isError = false
    form.error = null
    form.data = { key: KEY, open: false }
    mutateMake.mockResolvedValue(undefined)
    mutateRevoke.mockResolvedValue(undefined)
  })

  it('draws nothing, and does not read the key, for a person without the permission', () => {
    permissions.clear()
    const { container } = render(<DsrFormPanel />)
    expect(container.innerHTML).toBe('')
    expect(useDsrFormMock).toHaveBeenCalledWith(STORE, false)
  })

  it('shows the key and the address of the form with the key in the fragment, never in the query', () => {
    render(<DsrFormPanel />)
    const address = `${window.location.origin}${AppPaths.dsrRequest}#${DSR_REQUEST_FRAGMENT_KEY}=${KEY}`
    expect(screen.getByTestId('copied-text').textContent).toBe(address)
    expect(address).not.toContain('?')
    expect(screen.getByText('state.shut')).toBeTruthy()
  })

  it('says the form is open when the platform takes requests', () => {
    form.data = { key: KEY, open: true }
    render(<DsrFormPanel />)
    expect(screen.getByText('state.open')).toBeTruthy()
  })

  it('offers only to create a key when the store has none, and sends no current key', async () => {
    form.data = { key: null, open: false }
    render(<DsrFormPanel />)
    expect(screen.queryByTestId('copied-text')).toBeNull()
    expect(screen.getByText('none')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'replace.action' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'off.action' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'make' }))
    await waitFor(() => expect(mutateMake).toHaveBeenCalledWith({ current: null }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('done.make'))
  })

  it('changes the key only after the confirmation, sending the key the screen showed', async () => {
    render(<DsrFormPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'replace.action' }))
    expect(asked[0]).toMatchObject({
      title: 'replace.title',
      description: 'replace.description',
      confirmLabel: 'replace.confirm'
    })
    await waitFor(() => expect(mutateMake).toHaveBeenCalledWith({ current: KEY }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('done.replace'))
    expect(mutateRevoke).not.toHaveBeenCalled()
  })

  it('switches the form off after the confirmation, sending the key the screen showed', async () => {
    render(<DsrFormPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'off.action' }))
    expect(asked[0]).toMatchObject({ title: 'off.title', confirmLabel: 'off.confirm' })
    await waitFor(() => expect(mutateRevoke).toHaveBeenCalledWith({ current: KEY }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('done.revoke'))
    expect(mutateMake).not.toHaveBeenCalled()
  })

  it('tells the person in the words of the api when someone changed the key first', async () => {
    mutateMake.mockRejectedValueOnce('conflict')
    render(<DsrFormPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'replace.action' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('error:conflict'))
    expect(toastSuccess).not.toHaveBeenCalled()
    // The guard is released: a second try goes through
    fireEvent.click(screen.getByRole('button', { name: 'replace.action' }))
    await waitFor(() => expect(mutateMake).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('done.replace'))
  })

  it('shows a loading notice, then an error with a retry that reads the key again', () => {
    form.isPending = true
    const { rerender } = render(<DsrFormPanel />)
    expect(screen.getByRole('status').textContent).toBe('loading')
    form.isPending = false
    form.isError = true
    form.error = 'down'
    form.data = undefined
    rerender(<DsrFormPanel />)
    expect(screen.getByRole('alert').textContent).toContain('error:down')
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(form.refetch).toHaveBeenCalledTimes(1)
  })
})
