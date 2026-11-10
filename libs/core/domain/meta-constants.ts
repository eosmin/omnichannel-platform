// The only hosts that serve the thumbnail of the story an Instagram customer answered
// (`reply_to.story.url`). Exact host names, no wildcard: `*.fbsbx.com` also holds hosts that serve content of
// third parties. The Instagram plugin keeps a story link only when it is https on one of these, and the CSP of the
// web (`img-src`) allows the same list, so the two cannot drift.
export const MetaStoryImageHosts = ['lookaside.fbsbx.com'] as const
