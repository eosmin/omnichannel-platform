# i18n-server

Server-side translator for the texts the backend renders itself, today the emails.

It reads the same message files as the web app (`apps/web/messages/{en,es}.json`, `TDD_07 §5.2`),
and only the `email.*` namespace. Add a new email key there, in both locales.

`createTranslator` understands only `{name}` placeholders. next-intl reads the same files as ICU
messages (`{count, plural, ...}`, `''` for an apostrophe), so keep the `email.*` messages free of
plurals and apostrophes, or give the translator an ICU formatter first.
