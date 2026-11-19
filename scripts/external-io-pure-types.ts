// The field types that the check cannot follow (a library class, an interface, a token) and that do NOT do I/O outside the database
// (RLS phase 6, F6-3e). A type that does I/O goes in scripts/external-io-providers.ts instead. Redis, the queues and the cache are
// infrastructure of the platform with answers in milliseconds: they do not hold the transaction of a request for the network of a third
// party. `pnpm validate:external-io` fails on a called type that is on neither list, and on an entry here that no field has.
export interface ExternalIoPureType {
  readonly name: string
  readonly reason: string
}

const LANGUAGE = 'a type of the language or a generic: no I/O'
const INFRA = 'Redis or a queue of the platform: milliseconds, not a third party'
const OBSERVABILITY = 'in-process metric or log'

export const EXTERNAL_IO_PURE_TYPES: readonly ExternalIoPureType[] = [
  { name: 'Array', reason: LANGUAGE },
  { name: 'Map', reason: LANGUAGE },
  { name: 'Promise', reason: LANGUAGE },
  { name: 'NodeJS.Timeout', reason: 'the handle of a timer: clearTimeout, unref' },
  { name: 'T', reason: LANGUAGE },
  { name: 'Counter', reason: OBSERVABILITY },
  { name: 'Gauge', reason: OBSERVABILITY },
  { name: 'Histogram', reason: OBSERVABILITY },
  { name: 'Registry', reason: OBSERVABILITY },
  { name: 'PinoLogger', reason: OBSERVABILITY },
  { name: 'IssuerLogger', reason: OBSERVABILITY },
  { name: 'Redis', reason: INFRA },
  { name: 'Queue', reason: INFRA },
  { name: 'CacheHooks', reason: INFRA },
  { name: 'CarrierTokenCache', reason: INFRA },
  { name: 'ThrottlerStorage', reason: INFRA },
  { name: 'EventEmitter2', reason: 'in-process events' },
  { name: 'Reflector', reason: 'reads decorator metadata' },
  { name: 'ModuleRef', reason: 'the container of Nest' },
  { name: 'JwtService', reason: 'signs and verifies a token in memory' },
  {
    name: 'HealthCheckService',
    reason:
      'runs the indicators of the platform (database, Redis, bucket); the health route is public and has no transaction'
  },
  { name: 'HealthIndicatorService', reason: 'builds the answer of an indicator' },
  { name: 'Namespace', reason: 'emits to the realtime server of the platform (Redis adapter)' },
  { name: 'ExtendedClient', reason: 'the database client itself' },
  { name: 'IssuerDatabase', reason: 'the database, in the transaction of the caller' },
  { name: 'ChannelIdentityKindSource', reason: 'reads a declaration in memory' },
  { name: 'MessagingWindowPolicySource', reason: 'reads a declaration in memory' },
  { name: 'RemoteSecretSource', reason: 'reads the secrets of an installation from the database' }
]
