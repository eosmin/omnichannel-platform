export interface DigestLinks {
  // Origin of the web app: every link of a notification email is built on it
  frontendUrl: string
}

export const DIGEST_LINKS = Symbol('DIGEST_LINKS')
