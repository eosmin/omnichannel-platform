import { ApiKeyStatus } from '@platform/core/domain'

// What the settings page sees of a key: the prefix tells two keys apart, the key itself is never kept
export interface ApiKeyView {
  id: string
  name: string
  keyPrefix: string
  scopes: string[]
  status: string
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
  revokedAt: string | null
}

// The answer of the call that makes a key: the only time the key leaves the platform
export interface ApiKeyWithTokenView extends ApiKeyView {
  key: string
}

export const API_KEY_SELECT = {
  id: true,
  name: true,
  keyPrefix: true,
  scopes: true,
  status: true,
  lastUsedAt: true,
  expiresAt: true,
  createdAt: true,
  revokedAt: true
} as const

interface ApiKeyRow {
  id: string
  name: string
  keyPrefix: string
  scopes: string[]
  status: string
  lastUsedAt: Date | null
  expiresAt: Date | null
  createdAt: Date
  revokedAt: Date | null
}

// The status column is text: compared with the value of the enum as text
const ACTIVE: string = ApiKeyStatus.ACTIVE

export function apiKeyView(row: ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    // The column is flipped by nobody when the date passes: what the guard refuses is shown as expired
    status:
      row.status === ACTIVE && row.expiresAt !== null && row.expiresAt <= new Date()
        ? ApiKeyStatus.EXPIRED
        : row.status,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null
  }
}
