// The HTTP statuses the platform answers with, by name: the one place they are written as numbers.
// Nest's own HttpStatus is not used, so that there is a single source for the api, the libraries and,
// later, the web app and the widget, none of which should need Nest for a status. A status that is
// not here yet is added here; eslint refuses the usual ways of writing a bare number instead (see
// httpStatusBans in eslint.config.js).
//
// To ADD A STATUS: put it here with its standard number, and put its name in the "constant of your
// own" selector of httpStatusBans in eslint.config.js. errors.spec.ts checks both (the name against
// Node's reason phrase for the number, and that the name is in eslint.config.js).
export const HttpStatusCodes = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REQUEST_TIMEOUT: 408,
  CONFLICT: 409,
  GONE: 410,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500
} as const
