// The query keys of Settings → Routing and Business hours, kept with the pages that read them (see
// channel-keys.ts). The member and tag lists the rule editor needs are the inbox's own, under
// `QueryKeys`: one change there reaches both.
export const RoutingKeys = {
  rules: (storeId: string) => ['routing', storeId, 'rules'] as const,
  hours: (storeId: string) => ['routing', storeId, 'hours'] as const
}
