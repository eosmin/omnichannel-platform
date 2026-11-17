# `libs/fiscal/sv`: electronic tax documents of El Salvador

The provider of the Sistema de Transmisión DTE of the Ministerio de Hacienda. It is the only place that knows the country: core, the
API, the worker, the web, the SDK and the runtime read its manifest and nothing else (`pnpm validate:fiscal-agnostic`).

## State (Steps 4B.7c-2 and 4B.7c-3)

- **Done:** the pure construction of the invoice (`01`), the tax credit document (`03`) and the credit note (`05`); the checks of the issuer and of a receiver; the manifest; **the client of the authority** (Step 4B.7c-3): the token (kept, renewed, with a memory of a refused password), the signer port and the adapter of the official signing service, `submit` and `consult`; **the invalidation** (Step 4B.7c-4): the event of version 3, the deadlines (three months for an invoice, ten business days of the following month for the others), `void` and `consultVoid`.
- **Not yet:** the screens (4B.7c-5), the minimum tests in the sandbox (4B.7c-6), contingency (4B.7c-7).
- **Offered** where the deployment sets `FISCAL_SIGNER_URL` (the address of the official signing service: a private network, never published).
- **Never reaches the real authority in a test:** the specs and the contract suite run against `src/testing/fake-authority.ts`, a server of our own that plays the authority and the signer with a key generated for each run.

## Where the numbers come from

All the formulas and limits are from the public documents of the authority (the technical manual for the integration, version 2.0; the
functional manual, version 2.0; the catalogs, version 1.1). What this package could not verify against the authority itself (nothing
was sent to it) is marked in the code and in the plan: the tolerance of the tax (one hundredth, `SvLimits.TOLERANCE_CENTS`), the
wording of the amount in words, and the rules of the accountant (`[ACCOUNTANT]` in `sv-constants.ts`).

## Provenance of the data files

- `schemas/fe-f-v2.json`, `schemas/fe-ccf-v4.json`, `schemas/fe-nc-v4.json`: the JSON schemas of the invoice (version 2), the tax credit
  document (version 4) and the credit note (version 4) from `svfe-json-schemas` of the Ministerio de Hacienda (public technical
  documents). Reformatted by Prettier (whitespace only: the content is the authority's). Used only by the specs, to check every generated document against the schema of the authority. A new version of a schema
  replaces its file and the version in `SvSchemaVersions`.
- `schemas/invalidacion-v3.json`: the JSON schema of the invalidation event (version 3) from the same `svfe-json-schemas`. Used only by the specs.
- `src/catalogs/*.ts`: generated from "Catálogos - Facturación Electrónica", version 1.1 (07/2026) of the same ministry: departments
  (CAT-012), municipalities (CAT-013, with their department, derived from the name), districts (CAT-008), economic activities (CAT-019),
  units of measure (CAT-014), forms of payment (CAT-017), identity documents (CAT-022) and types of establishment (CAT-009). Data only; a
  new version of the catalogs replaces the files.

Not copied: the manuals, the signing certificate, any credential, nor the environment file of the sandbox.

## Rules the code follows

- Money is held in cents; the figures of an item go to eight decimals and those of the summary to two, half up, in integers.
- A document is never built from a sale that does not add up: the lines, the discount, the shipping fee and the tax must be the order's own
  total, and the tax must agree with the authority's formula within one hundredth. Anything else is refused with a code.
- The discount of the order is spread over the items (the field of each item); the global discounts of the summary stay empty.
- The shipping fee is a service of its own: taxed when the order taxed it, exempt when it carried no tax.
- An invoice holds the tax inside its prices; a tax credit document and a credit note show net prices and the tax apart.
