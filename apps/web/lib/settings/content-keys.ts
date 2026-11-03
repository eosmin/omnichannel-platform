// The query keys of Settings → Tags, Snippets and Inbox behavior, kept with the pages that read them
// (see channel-keys.ts). These pages need fields the inbox's lists leave out (a tag's description, when
// a snippet changed), so they read under their own keys; a write also invalidates the inbox's lists
// (`QueryKeys.tags`, `snippets`, `inboxBehavior`), so the composer and the filters never show old data.
export const ContentKeys = {
  tags: (storeId: string) => ['settings-content', storeId, 'tags'] as const,
  snippets: (storeId: string) => ['settings-content', storeId, 'snippets'] as const,
  inbox: (storeId: string) => ['settings-content', storeId, 'inbox'] as const,
  preferences: (storeId: string) => ['settings-content', storeId, 'preferences'] as const
}
