import type { ExternalIoProvider } from './lib/external-io-routes'

// The classes whose methods do I/O outside the database (RLS phase 6, F6-3d). A controller route that reaches one of them must carry
// @NoTenantTransaction(reason), because with RLS_CONTEXT on the request is ONE transaction of at most 15 s and a network call would
// hold it open. A new boundary (a new client of a carrier, a new bucket, a new mailer) is added here by the pull request that
// introduces it; `pnpm validate:external-io` fails when a name on this list no longer exists.
export const EXTERNAL_IO_PROVIDERS: readonly ExternalIoProvider[] = [
  { name: 'StorageService', reason: 'the bucket (S3 compatible)' },
  { name: 'EmailService', reason: 'the mail provider' },
  { name: 'PluginIconService', reason: 'downloads the icon of a plugin from its address' },
  { name: 'MetaGraphClient', reason: 'the HTTP API of the channel provider' },
  { name: 'S3Client', reason: 'the bucket, through the AWS SDK' },
  { name: 'Transporter', reason: 'the SMTP transport of nodemailer' },
  { name: 'EmailProvider', reason: 'the port of the mail provider' },
  { name: 'SvAuthOptions', reason: 'carries the fetch of the tax authority of El Salvador' }
]
