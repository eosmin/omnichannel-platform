import helmet, { contentSecurityPolicy } from 'helmet'

const ONE_YEAR_SECONDS = 31_536_000

// The headers of an api that answers JSON and nothing a browser should render (TDD_05 section 6):
// no source of anything is allowed, no page can frame it, and the browser is told to use https for a
// year. useDefaults is off because helmet's own CSP allows scripts and styles from the same origin.
export const apiSecurityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] }
  },
  hsts: { maxAge: ONE_YEAR_SECONDS, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginResourcePolicy: { policy: 'same-site' }
})

// The one page this api serves, Bull Board, needs its own scripts, styles and images, and nothing
// from outside: its web fonts from Google are refused on purpose, so that opening the board does not
// tell a third party who is looking at the queues (the browser falls back to its own fonts).
export const bullBoardContentSecurityPolicy = contentSecurityPolicy({
  useDefaults: false,
  directives: {
    defaultSrc: ["'none'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"], // The page has style attributes and a style block
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"]
  }
})
