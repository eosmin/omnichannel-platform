// The key of the metadata of a 429 that says how long to wait: the api writes it, the web reads it. Its own file, not part of the auth
// constants: those hold values that run code when they load (a Symbol, a function), and the web, which reads the key in the code that
// every screen shares, would carry them along (the lighthouse budget of the orders screen)
export const RETRY_AFTER_METADATA_KEY = 'retryAfterSeconds'
