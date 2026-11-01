import { escapeLike } from '../customers/customers.support'

// Digits, spaces and the punctuation a phone number is written with, and at least three digits
const PHONE_LIKE = /^(?=(?:\D*\d){3})[\d\s+().-]+$/

// The customers of a store that a search text finds, absorbed ones left out. The list of customers
// and their export use the same rule, so the file holds the rows the screen shows.
export interface CustomerSearchWhere {
  storeId: string
  mergedIntoId: null
  OR?: Record<string, unknown>[]
}

export function customerSearchWhere(storeId: string, q: string | undefined): CustomerSearchWhere {
  const text = q === undefined ? null : escapeLike(q)
  // "Calle 123" is a street and "7123-4567" a phone: the digits are looked for in the phones only
  // when nothing but digits and the punctuation of a phone was typed
  const digits = q !== undefined && PHONE_LIKE.test(q) ? q.replace(/\D/g, '') : ''
  return {
    storeId,
    mergedIntoId: null,
    ...(text === null
      ? {}
      : {
          OR: [
            { name: { contains: text, mode: 'insensitive' as const } },
            { email: { contains: text, mode: 'insensitive' as const } },
            ...(digits === '' ? [] : [{ phoneNormalized: { contains: digits } }])
          ]
        })
  }
}
