/**
 * @jest-environment jsdom
 */
import { renderHook } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import type { ReactElement, ReactNode } from 'react'

import { ApiError } from '@platform/api-client'

import en from '../messages/en.json'
import es from '../messages/es.json'

import { useErrorText } from './use-error-text'

const catalogs = { es, en } as const

function textOf(locale: 'es' | 'en', error: unknown): string {
  const wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <NextIntlClientProvider locale={locale} messages={catalogs[locale]}>
      {children}
    </NextIntlClientProvider>
  )
  return renderHook(() => useErrorText(), { wrapper }).result.current(error)
}

describe('the words of an error that carries a number or a kind', () => {
  it('names the limit of a file that is too large (FILE_TOO_LARGE)', () => {
    const error = new ApiError(400, 'FILE_TOO_LARGE', 'x', null, { maxSizeBytes: 10 * 1024 * 1024 })
    expect(textOf('es', error)).toBe('El archivo pesa más de 10 MB. Elige uno más pequeño')
    expect(textOf('en', error)).toContain('10 MB')
  })

  it('says how long to wait after too many requests, in the unit that reads best', () => {
    const wait = (seconds: number): ApiError =>
      new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'x', null, { retryAfterSeconds: seconds })
    expect(textOf('es', wait(1))).toBe(
      'Hay demasiadas solicitudes. Inténtalo de nuevo en 1 segundo'
    )
    expect(textOf('es', wait(45))).toBe(
      'Hay demasiadas solicitudes. Inténtalo de nuevo en 45 segundos'
    )
    expect(textOf('es', wait(61))).toBe(
      'Hay demasiadas solicitudes. Inténtalo de nuevo en 2 minutos'
    )
    expect(textOf('en', wait(120))).toBe('Too many requests. Try again in 2 minutes')
  })

  it('keeps the message of the code when the api sent no number', () => {
    expect(textOf('es', new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'x'))).toBe(
      es.errors.RATE_LIMIT_EXCEEDED
    )
    expect(textOf('es', new ApiError(400, 'FILE_TOO_LARGE', 'x'))).toBe(es.errors.FILE_TOO_LARGE)
  })

  // CAR-010: a second check of the chain while one runs said "someone changed it, reload", which is not what happened
  it('says a check of the chain is running, not that someone changed the data', () => {
    const error = new ApiError(409, 'RESOURCE_CONFLICT', 'x', null, {
      conflict: 'chain_check_running'
    })
    expect(textOf('es', error)).toBe(es.errorDetails.conflicts.chain_check_running)
    expect(textOf('es', error)).not.toBe(es.errors.RESOURCE_CONFLICT)
  })

  it('keeps the message of the code for a conflict kind the page has no sentence for', () => {
    const error = new ApiError(409, 'RESOURCE_CONFLICT', 'x', null, { conflict: 'something_new' })
    expect(textOf('es', error)).toBe(es.errors.RESOURCE_CONFLICT)
  })

  it('says the request cannot be approved yet for the kinds that can only be rejected, not only for erasure (DSR-TXT)', () => {
    const error = new ApiError(409, 'DSR_EXECUTOR_UNAVAILABLE', 'x')
    expect(textOf('es', error)).not.toMatch(/borrado/)
    expect(textOf('en', error)).not.toMatch(/rasure/)
  })
})
