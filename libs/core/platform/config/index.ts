// env.ts parses process.env when imported, so it is not re-exported here: import it from
// '@platform/core/config/env' in the modules that need the validated values.
export * from './env-schema'
export * from './duration'
