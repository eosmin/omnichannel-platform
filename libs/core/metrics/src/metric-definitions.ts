import { MetricNames, type MetricName } from '@platform/core/metrics'

export type MetricKind = 'counter' | 'gauge' | 'histogram'

export interface MetricDefinition {
  kind: MetricKind
  help: string
  // Bounded values only: never a customer id, a message id or free text
  labels: readonly string[]
  buckets?: readonly number[]
}

const SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

// One definition per MetricNames entry: the Record type fails the compilation when a name has none.
// Labels and buckets are the ones TDD_04 §2 and TDD_07 §1 show; the rest follow the same rule and
// are listed in MVP_TRIM_CHECKLIST.md for review.
export const MetricDefinitions: Record<MetricName, MetricDefinition> = {
  [MetricNames.HTTP_REQUESTS_TOTAL]: {
    kind: 'counter',
    help: 'HTTP requests served',
    labels: ['method', 'route', 'status_code']
  },
  [MetricNames.HTTP_REQUEST_DURATION]: {
    kind: 'histogram',
    help: 'HTTP request duration in seconds',
    labels: ['method', 'route', 'status_code'],
    buckets: SECONDS_BUCKETS
  },

  [MetricNames.CONVERSATIONS_CREATED]: {
    kind: 'counter',
    help: 'Conversations created',
    labels: ['store_id', 'channel_type']
  },
  [MetricNames.CONVERSATIONS_RESOLVED]: {
    kind: 'counter',
    help: 'Conversations resolved',
    labels: ['store_id']
  },
  [MetricNames.MESSAGES_RECEIVED]: {
    kind: 'counter',
    help: 'Inbound messages received',
    labels: ['channel_type']
  },
  [MetricNames.MESSAGES_SENT]: {
    kind: 'counter',
    help: 'Outbound messages sent',
    labels: ['channel_type', 'status']
  },
  [MetricNames.MESSAGE_SEND_DURATION]: {
    kind: 'histogram',
    help: 'Time to send a message through a channel',
    labels: ['channel_type', 'message_type'],
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10]
  },
  [MetricNames.ORDERS_CREATED]: {
    kind: 'counter',
    help: 'Total orders created',
    labels: ['store_id', 'status', 'payment_method']
  },
  [MetricNames.ORDER_VALUE]: {
    kind: 'histogram',
    help: 'Value of the orders created, in USD',
    labels: ['store_id'],
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 5000]
  },
  [MetricNames.ORDER_MESSAGES_FAILED_TOTAL]: {
    kind: 'counter',
    help: 'Order messages that could not be sent to the customer',
    labels: ['store_id']
  },

  [MetricNames.INVENTORY_RECONCILIATION_MISMATCHES]: {
    kind: 'counter',
    help: 'Stock levels that did not match the movement ledger in the daily reconciliation',
    labels: ['store_id']
  },

  [MetricNames.SHIPMENTS_CREATED_TOTAL]: {
    kind: 'counter',
    help: 'Shipments created',
    labels: ['carrier']
  },
  [MetricNames.SHIPMENT_CARRIER_ERRORS_TOTAL]: {
    kind: 'counter',
    help: 'Errors returned by a carrier',
    labels: ['carrier', 'code']
  },
  [MetricNames.SHIPMENT_UNKNOWN_STATUS_TOTAL]: {
    kind: 'counter',
    help: 'Carrier status codes that matched no mapping',
    labels: ['carrier']
  },
  [MetricNames.PICKUPS_REQUESTED_TOTAL]: {
    kind: 'counter',
    help: 'Pickups requested from a carrier',
    labels: ['carrier']
  },

  [MetricNames.AUTH_FAILURES]: {
    kind: 'counter',
    help: 'Failed authentication attempts',
    labels: ['reason']
  },
  [MetricNames.PERMISSION_DENIALS]: {
    kind: 'counter',
    help: 'Requests refused for a missing permission',
    labels: ['permission']
  },
  [MetricNames.TENANT_VIOLATIONS]: {
    kind: 'counter',
    help: "Requests that attempted to reach another tenant's data",
    labels: ['resource']
  },
  [MetricNames.RATE_LIMIT_HITS]: {
    kind: 'counter',
    help: 'Requests refused by a rate limit',
    labels: ['throttler']
  },

  [MetricNames.QUEUE_DEPTH]: {
    kind: 'gauge',
    help: 'Number of jobs in queue by state',
    labels: ['queue', 'state']
  },
  [MetricNames.QUEUE_PROCESSED]: {
    kind: 'counter',
    help: 'Jobs processed',
    labels: ['queue', 'job']
  },
  [MetricNames.QUEUE_FAILED]: {
    kind: 'counter',
    help: 'Jobs that failed',
    labels: ['queue', 'job']
  },
  [MetricNames.QUEUE_PROCESSING_DURATION]: {
    kind: 'histogram',
    help: 'Time a job took to process, in seconds',
    labels: ['queue', 'job'],
    buckets: [0.05, 0.1, 0.5, 1, 5, 15, 30, 60, 120]
  },

  [MetricNames.CHANNEL_WEBHOOK_RECEIVED]: {
    kind: 'counter',
    help: 'Channel webhooks received',
    labels: ['channel_type']
  },
  [MetricNames.CHANNEL_WEBHOOK_REJECTED]: {
    kind: 'counter',
    help: 'Channel webhooks rejected',
    labels: ['channel_type', 'reason']
  },
  [MetricNames.CHANNEL_API_ERRORS]: {
    kind: 'counter',
    help: 'Errors returned by a channel API',
    labels: ['channel_type', 'code']
  },
  [MetricNames.CHANNEL_CONNECTIONS_ACTIVE]: {
    kind: 'gauge',
    help: 'Active channel connections',
    labels: ['channel_type']
  },

  [MetricNames.WEBHOOK_DELIVERIES]: {
    kind: 'counter',
    help: 'Outbound webhook deliveries',
    labels: ['success']
  },
  [MetricNames.EMAILS_SENT]: {
    kind: 'counter',
    help: 'Emails sent',
    labels: ['template', 'status']
  },

  [MetricNames.WEBSOCKET_CONNECTIONS]: {
    kind: 'gauge',
    help: 'Active WebSocket connections',
    labels: ['store_id']
  },
  [MetricNames.WEBSOCKET_EVENTS_EMITTED]: {
    kind: 'counter',
    help: 'Realtime events emitted',
    labels: ['event']
  },

  [MetricNames.CACHE_HITS]: {
    kind: 'counter',
    help: 'Cache hits',
    labels: ['namespace']
  },
  [MetricNames.CACHE_MISSES]: {
    kind: 'counter',
    help: 'Cache misses',
    labels: ['namespace']
  },

  [MetricNames.DB_QUERY_DURATION]: {
    kind: 'histogram',
    help: 'Database query duration in seconds',
    labels: ['model', 'operation'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]
  }
}
