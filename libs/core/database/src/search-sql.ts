import { SearchLanguage, SearchLiteralLanguage } from '@platform/core/domain'

import { Prisma } from '../generated/client/client'

// The text-search configuration as a SQL literal. `websearch_to_tsquery`, `to_tsvector` and `ts_headline` take a
// `regconfig` first, and a bind parameter arrives as `text` ("function does not exist"), so the configuration is
// spliced in. It is a constant of the platform: nothing a user typed ever reaches it. The index of the messages
// (migration search_unaccent) is built on the same literal, so a query only uses it when the two read the same.
export const SEARCH_LANGUAGE_SQL = Prisma.raw(`'${SearchLanguage}'::regconfig`)

export const SEARCH_LITERAL_LANGUAGE_SQL = Prisma.raw(`'${SearchLiteralLanguage}'::regconfig`)

// A piece of a raw statement that is built apart and spliced into it (the conditions two searches share). Its bind
// parameters stay bind parameters: only a `Sql` made with this tag can be spliced, a plain string never is.
export const rawSql = Prisma.sql
export type RawSql = Prisma.Sql
