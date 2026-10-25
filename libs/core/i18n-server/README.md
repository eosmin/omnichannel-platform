# i18n-server

Server-side translator for the texts the backend renders itself, today the emails.

`messages/{en,es}.json` hold only the `email.*` namespace. TDD_07 §5.2 says emails use the same
message files as next-intl (`apps/web/messages`), but that directory cannot exist before Step 3.1:
`pnpm validate:translations` then demands every generated key (statuses, error codes, notification
types) in every locale. **Step 3.1 merges these two files into `apps/web/messages/*.json`, points
`src/messages.ts` there and deletes `messages/` here.** Until then, add new `email.*` keys here.

`createTranslator` understands only `{name}` placeholders. next-intl reads the same files as ICU
messages (`{count, plural, ...}`, `''` for an apostrophe), so when the files are merged, keep the
`email.*` messages free of plurals and apostrophes, or give the translator an ICU formatter first.
