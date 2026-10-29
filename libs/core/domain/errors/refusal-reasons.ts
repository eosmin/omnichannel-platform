// The `reason` in the metadata of a refusal that has one code for several causes, so that the
// interface can tell them apart without reading the message
export const RefusalReasons = {
  // An invitation for an address that already has an account: sign in with it first
  LOGIN_REQUIRED: 'login_required'
} as const
