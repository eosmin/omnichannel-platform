// Where the integration suites of the worker find Redis and Mailpit: the variables CI and .env.example
// define, with the local docker compose addresses as defaults. The one file of the worker that reads
// process.env; the suites themselves import these constants.
export const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379'
export const SMTP_URL = process.env['SMTP_URL'] ?? 'smtp://localhost:1025'
export const MAILPIT_API_URL = process.env['MAILPIT_API_URL'] ?? 'http://localhost:8025'
// The database as its owner: the suites write the rows of a store, which the role of the worker cannot
export const DIRECT_DATABASE_URL =
  process.env['DIRECT_DATABASE_URL'] ??
  'postgresql://platform:dev_password@localhost:5432/platform_dev'
