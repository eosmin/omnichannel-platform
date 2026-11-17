# `libs/fiscal/conformance`: the runner of the minimum tests of an authority's sandbox

A tool, run by hand by the owner (`pnpm fiscal:conformance`), that makes and sends the documents an authority asks before it authorizes an
issuer (for El Salvador: 90 invoices, 75 tax credit documents and 50 credit notes with seal, 5 invalidations, 5 contingencies) from invented
data, through the **port** of a provider. It needs no database and never goes through the lifecycle of core. By default it runs the
simulator; against a real sandbox it runs only on the owner's machine, with their environment and their confirmation, and it never prints,
logs or saves a credential, a token, a password, a tax number or a signed document.

## Why it lives here and not in `runtime` or `core`

It has to know providers: it picks one by name (`--provider simulator|sv`) and runs the plan that provider package makes. Core, the API, the
worker, the web, the SDK and the runtime must not (`pnpm validate:fiscal-agnostic`, CLAUDE.md rule 13), and the only file of them that may
import the provider packages is the composition root of the registry (`libs/fiscal/runtime/src/official-providers.ts`). This tool is not part
of the platform: no app imports it, nothing at run time depends on it, and it is not deployed. It is a package that knows providers, like
`libs/fiscal/sv` itself, so it sits beside them and is not one of the scanned roots; it is not a way around the check:

- **The agnostic part is in the SDK** (`libs/fiscal/sdk/src/conformance.ts`): the runner, the report, the leak gate and the gaps know no
  country and no provider, and are scanned like the rest of the SDK.
- **The plan of El Salvador is in `libs/fiscal/sv`** (`src/conformance/`), where the country is allowed.
- **This package only connects them** (`conformance-cli.ts`: arguments, the gates of a real send, the summary and the exit codes;
  `run-conformance.ts`: the process). The boundaries of Nx (`scope:fiscal-runtime`) let it depend on the SDK, the providers and the domain,
  and nothing else; `validate:fiscal-agnostic` stays at its baseline (it does not grow).

The tests (`src/*.spec.ts`) cover the gates (what the tool refuses before it builds anything), the exit codes, and the plan through the
simulator. The plan and the runner have their own specs in the packages they live in.

## Use

See the header of `src/run-conformance.ts` and the section "The minimum tests of the sandbox" of `libs/fiscal/sv/README.md`.
