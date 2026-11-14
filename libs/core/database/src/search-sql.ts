import { SearchLanguage } from '@platform/core/domain'

import { Prisma } from '../generated/client/client'

// The text-search configuration as a SQL literal. `websearch_to_tsquery`, `to_tsvector` and `ts_headline` take a
// `regconfig` first, and a bind parameter arrives as `text` ("function does not exist"), so the configuration is
// spliced in. It is a constant of the platform: nothing a user typed ever reaches it. The index of the messages
// (migration search_unaccent) is built on the same literal, so a query only uses it when the two read the same.
export const SEARCH_LANGUAGE_SQL = Prisma.raw(`'${SearchLanguage}'::regconfig`)
