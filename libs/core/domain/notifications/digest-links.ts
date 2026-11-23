export interface DigestLinks {
  // Origin of the web app: every link of a notification email is built on it
  frontendUrl: string
}

export const DIGEST_LINKS = Symbol('DIGEST_LINKS')

// The two addresses of the one-click unsubscribe of one person (Step 7.3, B6b-3b2b), signed for them. Built where the key lives; a reader of
// the email never sees the key, only these.
export interface UnsubscribeLinkSet {
  // What the footer of the email opens: the page of the web app that asks "stop these notices?" and does the POST. The token is in the
  // fragment, so the browser never sends it to a server and never puts it in a Referer
  pageUrl: string
  // What the `List-Unsubscribe` header points to, and what a mail client POSTs to (RFC 8058): the api route itself, the token in the query.
  // The token in a URL is unavoidable here (the client POSTs straight to it, with no page in between); the query is named `token`, which the
  // logs and error reports of the api redact
  postUrl: string
}

export interface UnsubscribeLinks {
  forUser(userId: string): UnsubscribeLinkSet
}

export const UNSUBSCRIBE_LINKS = Symbol('UNSUBSCRIBE_LINKS')

// The name of the token in the query of the POST url, in the fragment of the page url and in the body of the POST
export const UNSUBSCRIBE_TOKEN_PARAM = 'token'

// The keys a one-click unsubscribe link may have been signed under (the key in force first, then the previous one of an open rotation). Only the
// api verifies with them; neither the worker nor the web ever gets them
export const UNSUBSCRIBE_VERIFICATION_KEYS = Symbol('UNSUBSCRIBE_VERIFICATION_KEYS')
