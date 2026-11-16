'use client'

import { type ChangeEvent, useCallback, useMemo, useRef, useState } from 'react'

import { BankStatementLimits } from '@platform/core/domain'

import { type DecodedFile, decodeFile, type ImportEncoding } from '../remittances/import-mapper'

export interface BankFileChoice {
  // The bytes of the file as they were read, sent as they are; null until a readable file is chosen
  bytes: ArrayBuffer | null
  // The text of the file in the encoding given, or why it is not one; null until a file is chosen
  decoded: DecodedFile | null
  // Forgets the file: a refused statement is chosen again (the browser will not say a file changed on disk)
  reset: () => void
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
}

// A file chosen in a form (the statement, or the sample the mapper reads). The browser reads it once; the text is made again from the
// bytes whenever the encoding changes, so Windows-1252 (what a spreadsheet saves) is a choice and not a second upload. A file larger than
// a statement can be is never read into memory, and only the last file chosen counts when two reads overlap.
export function useBankFile(encoding: string): BankFileChoice {
  const [buffer, setBuffer] = useState<ArrayBuffer | 'too_large' | null>(null)
  const latest = useRef(0)
  const decoded = useMemo<DecodedFile | null>(() => {
    if (buffer === null) return null
    if (buffer === 'too_large') return { ok: false, reason: 'too_large' }
    return decodeFile(buffer, encoding as ImportEncoding)
  }, [buffer, encoding])
  const onChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    latest.current += 1
    const mine = latest.current
    const chosen = event.target.files?.[0]
    if (chosen === undefined) {
      setBuffer(null)
      return
    }
    if (chosen.size > BankStatementLimits.MAX_BYTES) {
      setBuffer('too_large')
      return
    }
    void chosen.arrayBuffer().then(
      bytes => {
        if (latest.current === mine) setBuffer(bytes)
      },
      () => {
        if (latest.current === mine) setBuffer(null)
      }
    )
  }, [])
  const reset = useCallback((): void => {
    latest.current += 1
    setBuffer(null)
  }, [])
  return {
    reset,
    bytes: buffer === null || buffer === 'too_large' ? null : buffer,
    decoded,
    onChange
  }
}
