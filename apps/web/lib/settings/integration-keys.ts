// The query keys of Settings → Webhooks, API keys, Data retention and Safety, kept with the pages that read them (see
// content-keys.ts): nothing else reads these lists.
export const IntegrationKeys = {
  webhooks: (storeId: string) => ['settings-integrations', storeId, 'webhooks'] as const,
  // One webhook's log, by outcome filter; a page is the cursor it starts from
  deliveries: (storeId: string, webhookId: string, outcome: string) =>
    ['settings-integrations', storeId, 'webhooks', webhookId, 'deliveries', outcome] as const,
  apiKeys: (storeId: string) => ['settings-integrations', storeId, 'api-keys'] as const,
  retention: (storeId: string) => ['settings-integrations', storeId, 'retention'] as const,
  safety: (storeId: string) => ['settings-integrations', storeId, 'safety'] as const
}
