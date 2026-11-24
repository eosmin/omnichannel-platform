// Routes are full paths relative to the version prefix. Controllers declare @Controller() with
// no prefix and use the constant on the method, passing ':id' placeholders to the path builders:
//
//   @Get(ApiRoutes.conversations.byId(':id'))   // '/conversations/:id'
//
// No route constant contains /api/v1: the frontend apiClient prepends it once.
//
// Literal siblings of a parameterised route (/orders/export next to /orders/:id, and the same for
// bulk, search, registry, available and pending) must be declared BEFORE it in the controller:
// Express matches in registration order, so the other way round 'export' is read as an id.
export const ApiRoutes = {
  // Login is a magic link: there is no password, no signup and no OAuth (TDD_02 v1.2 trim).
  auth: {
    magicLinkRequest: '/auth/magic-link/request',
    magicLinkConsume: '/auth/magic-link/consume', // POST with the token in the body, never a GET
    logout: '/auth/logout',
    refresh: '/auth/refresh',
    me: '/auth/me',
    sessions: '/auth/sessions',
    sessionById: (id: string) => `/auth/sessions/${id}`
  },

  // The organization is created by the seed only: read and update, never create.
  organizations: {
    current: '/organizations/current',
    stores: '/organizations/current/stores',
    storeById: (id: string) => `/organizations/current/stores/${id}`,
    auditLog: '/organizations/current/audit-log',
    auditLogExport: '/organizations/current/audit-log/export',
    auditLogEntry: (id: string) => `/organizations/current/audit-log/${id}`
  },

  // Public. Accepting creates the account (when there is none), the membership and the session.
  invitations: {
    byToken: (token: string) => `/invitations/${token}`, // Preview
    accept: (token: string) => `/invitations/${token}/accept`
  },

  conversations: {
    list: '/conversations',
    byId: (id: string) => `/conversations/${id}`,
    messages: (id: string) => `/conversations/${id}/messages`,
    assign: (id: string) => `/conversations/${id}/assign`,
    status: (id: string) => `/conversations/${id}/status`,
    snooze: (id: string) => `/conversations/${id}/snooze`,
    tags: (id: string) => `/conversations/${id}/tags`,
    tagById: (id: string, tagId: string) => `/conversations/${id}/tags/${tagId}`,
    read: (id: string) => `/conversations/${id}/read`,
    unread: (id: string) => `/conversations/${id}/unread`,
    messagingWindow: (id: string) => `/conversations/${id}/messaging-window`,
    origins: (id: string) => `/conversations/${id}/origins`,
    bulk: '/conversations/bulk',
    export: '/conversations/export'
  },

  messages: {
    create: '/messages',
    byId: (id: string) => `/messages/${id}`,
    resend: (id: string) => `/messages/${id}/resend`,
    discard: (id: string) => `/messages/${id}/discard`,
    resendCaption: (id: string) => `/messages/${id}/resend-caption`,
    refetchFile: (id: string, index: number | string) => `/messages/${id}/files/${index}/refetch`,
    reaction: (id: string) => `/messages/${id}/reaction`,
    deletedContent: (id: string) => `/messages/${id}/deleted-content`,
    revisions: (id: string) => `/messages/${id}/revisions`
  },

  customers: {
    list: '/customers',
    byId: (id: string) => `/customers/${id}`,
    identities: (id: string) => `/customers/${id}/identities`,
    identityById: (id: string, identityId: string) => `/customers/${id}/identities/${identityId}`,
    merge: (id: string) => `/customers/${id}/merge`,
    unmerge: (id: string) => `/customers/${id}/unmerge`,
    mergePreview: (id: string) => `/customers/${id}/merge-preview`,
    orders: (id: string) => `/customers/${id}/orders`,
    conversations: (id: string) => `/customers/${id}/conversations`,
    notes: (id: string) => `/customers/${id}/notes`,
    noteById: (id: string, noteId: string) => `/customers/${id}/notes/${noteId}`,
    addresses: (id: string) => `/customers/${id}/addresses`,
    addressById: (id: string, addressId: string) => `/customers/${id}/addresses/${addressId}`,
    tags: (id: string) => `/customers/${id}/tags`,
    tagById: (id: string, tagId: string) => `/customers/${id}/tags/${tagId}`,
    media: (id: string) => `/customers/${id}/media`,
    timeline: (id: string) => `/customers/${id}/timeline`,
    caution: (id: string) => `/customers/${id}/caution`, // PUT sets it with a reason, DELETE clears it
    erasure: (id: string) => `/customers/${id}/erasure`, // POST erases the personal data of the customer (Step 7.2)
    export: '/customers/export'
  },

  orders: {
    list: '/orders',
    create: '/orders',
    byId: (id: string) => `/orders/${id}`,
    cancel: (id: string) => `/orders/${id}/cancel`,
    status: (id: string) => `/orders/${id}/status`,
    items: (id: string) => `/orders/${id}/items`,
    print: (id: string, doc: string) => `/orders/${id}/print/${doc}`,
    export: '/orders/export',
    confirm: (id: string) => `/orders/${id}/confirm`,
    confirmBulk: '/orders/confirm-bulk',
    copy: (id: string) => `/orders/${id}/copy`, // A prefilled draft: nothing is written
    messages: (id: string) => `/orders/${id}/messages`, // ?preview=true renders without sending
    payment: (id: string) => `/orders/${id}/payment`, // POST records a payment by hand (v1.2: no online gateway)
    priceApprovalApprove: (id: string) => `/orders/${id}/price-approval/approve`,
    priceApprovalReject: (id: string) => `/orders/${id}/price-approval/reject`
  },

  products: {
    list: '/products',
    create: '/products',
    byId: (id: string) => `/products/${id}`,
    variants: (id: string) => `/products/${id}/variants`,
    images: (id: string) => `/products/${id}/images`, // The live pictures of a product, oldest first
    variantById: (id: string, variantId: string) => `/products/${id}/variants/${variantId}`,
    search: '/products/search',
    inventory: (id: string) => `/products/${id}/inventory` // Levels per warehouse, read only
  },

  // Organization-scoped (TDD_16 §6)
  warehouses: {
    list: '/warehouses',
    create: '/warehouses',
    byId: (id: string) => `/warehouses/${id}`,
    stores: (id: string) => `/warehouses/${id}/stores` // PUT replaces the store links atomically
  },

  inventory: {
    levels: '/inventory/levels',
    // The available stock of up to 100 products of the store, one row each (the stock column of the catalog)
    summary: '/inventory/summary',
    movements: '/inventory/movements',
    kardex: '/inventory/kardex',
    adjustments: '/inventory/adjustments'
  },

  transfers: {
    list: '/transfers',
    create: '/transfers',
    byId: (id: string) => `/transfers/${id}`,
    dispatch: (id: string) => `/transfers/${id}/dispatch`,
    receive: (id: string) => `/transfers/${id}/receive`,
    close: (id: string) => `/transfers/${id}/close`,
    cancel: (id: string) => `/transfers/${id}/cancel`
  },

  counts: {
    list: '/counts',
    create: '/counts',
    byId: (id: string) => `/counts/${id}`,
    start: (id: string) => `/counts/${id}/start`,
    lines: (id: string) => `/counts/${id}/lines`,
    submit: (id: string) => `/counts/${id}/submit`,
    // Sends a count in review back to counting: the approver asks for a recount
    reopen: (id: string) => `/counts/${id}/reopen`,
    apply: (id: string) => `/counts/${id}/apply`,
    cancel: (id: string) => `/counts/${id}/cancel`
  },

  // Finance (TDD_18 §12): the books of the ORGANIZATION, read from the store of X-Store-Id like the warehouses. The routes
  // of purchases, taxes, transactions, reports, exports and fiscal documents come with the steps that build them.
  finance: {
    // GET says whether the organization has its books and which countries have a template; POST sets them up once
    setup: '/finance/setup',
    settings: '/finance/settings',
    accounts: {
      list: '/finance/accounts',
      create: '/finance/accounts',
      byId: (id: string) => `/finance/accounts/${id}`,
      deactivate: (id: string) => `/finance/accounts/${id}/deactivate`,
      reactivate: (id: string) => `/finance/accounts/${id}/reactivate`
    },
    accountRoles: {
      list: '/finance/account-roles',
      // PUT maps the role to an account
      byRole: (role: string) => `/finance/account-roles/${role}`
    },
    // The tax rates of the organization (TDD_18 §7)
    taxRates: {
      list: '/finance/tax-rates',
      create: '/finance/tax-rates',
      byId: (id: string) => `/finance/tax-rates/${id}`,
      deactivate: (id: string) => `/finance/tax-rates/${id}/deactivate`,
      reactivate: (id: string) => `/finance/tax-rates/${id}/reactivate`
    },
    // The VAT report of the organization for a range of days (TDD_18 §7): the JSON, and the same rows as a CSV
    reports: {
      vat: '/finance/reports/vat',
      vatCsv: '/finance/reports/vat.csv',
      // The trial balance of a period (debits and credits by account), and the ledger of one account with its running balance (Step 4B.8)
      trialBalance: '/finance/reports/trial-balance',
      ledger: '/finance/reports/ledger',
      // Each account's balance at a date, and the journal of a range with the lines of every entry (TDD_18 §10)
      accountBalances: '/finance/reports/account-balances',
      journal: '/finance/reports/journal',
      // What the auditor takes out (TDD_18 §10, §11): CSV files, audited, and the check of the hash chain
      trialBalanceCsv: '/finance/reports/trial-balance.csv',
      ledgerCsv: '/finance/reports/ledger.csv',
      journalCsv: '/finance/reports/journal.csv',
      verifyChain: '/finance/reports/verify-chain',
      // The incident of the chain the weekly check left open, or none (Step 4B.8b-2)
      chainStatus: '/finance/reports/chain-status',
      // Ask the worker to check the chain again and close the incident if it passes (N-B8-1): the api role cannot close one itself
      resolveChain: '/finance/reports/chain-status/resolve',
      // The statements and the lists with age (Step 4B.8b), by store when asked, as of a date or over a range, with their CSV files
      incomeStatement: '/finance/reports/income-statement',
      balanceSheet: '/finance/reports/balance-sheet',
      cashFlow: '/finance/reports/cash-flow',
      aging: '/finance/reports/aging',
      incomeStatementCsv: '/finance/reports/income-statement.csv',
      balanceSheetCsv: '/finance/reports/balance-sheet.csv',
      cashFlowCsv: '/finance/reports/cash-flow.csv',
      agingCsv: '/finance/reports/aging.csv',
      // The margin by product and store, read against the ledger's revenue and cost of goods (Step 4B.8b-2)
      margin: '/finance/reports/margin',
      marginCsv: '/finance/reports/margin.csv'
    },
    // The legal books (TDD_18 §7, Step 4B.8b-3): the layout of each kind of book is the organization's (PUT writes a new version), a book is
    // read for a period, as JSON and as a CSV, and a closed period's book is frozen and listed
    bookLayouts: {
      list: '/finance/book-layouts',
      byKind: (kind: string) => `/finance/book-layouts/${kind}`
    },
    books: {
      byKind: (kind: string) => `/finance/books/${kind}`,
      csvByKind: (kind: string) => `/finance/books/${kind}/csv`
    },
    frozenBooks: {
      list: '/finance/frozen-books',
      byId: (id: string) => `/finance/frozen-books/${id}`
    },
    // The tax preferences of the store of X-Store-Id: GET reads them, PATCH changes whether its prices include the tax
    storeTaxSettings: '/finance/store-tax-settings',
    paymentAccounts: {
      list: '/finance/payment-accounts',
      // PUT chooses the account a payment method lands in (for the organization, or for one store)
      set: '/finance/payment-accounts',
      // DELETE takes a store's own choice away, so the default of the organization applies again
      byId: (id: string) => `/finance/payment-accounts/${id}`
    },
    periods: {
      list: '/finance/periods',
      // POST opens the period of a month before any entry needs it
      open: '/finance/periods',
      byId: (id: string) => `/finance/periods/${id}`,
      // POST closes the month (the preconditions of TDD_18 §5.1); POST reopens the latest closed one with a reason (§5.3)
      close: (id: string) => `/finance/periods/${id}/close`,
      reopen: (id: string) => `/finance/periods/${id}/reopen`
    },
    entries: {
      list: '/finance/entries',
      manual: '/finance/entries',
      byId: (id: string) => `/finance/entries/${id}`,
      reverse: (id: string) => `/finance/entries/${id}/reverse`
    },
    // What a person registers by hand: an expense, an income, a transfer (TDD_18 §4.3)
    transactions: {
      list: '/finance/transactions',
      record: '/finance/transactions',
      byId: (id: string) => `/finance/transactions/${id}`,
      void: (id: string) => `/finance/transactions/${id}/void`,
      replace: (id: string) => `/finance/transactions/${id}/replace`,
      // The receipt: POST names the file (a Media of purpose finance_document uploaded for this transaction), GET gives its signed links
      document: (id: string) => `/finance/transactions/${id}/document`
    },
    // Bank reconciliation by CSV (TDD_18 §4.4): the profiles that read a bank's file, the import, the suggestions a person decides on
    bank: {
      profiles: '/finance/bank-profiles',
      profileById: (id: string) => `/finance/bank-profiles/${id}`,
      // The mapper: a sample of a file read with the mapping being tried; it writes nothing
      profilePreview: '/finance/bank-profiles/preview',
      // POST takes the file itself (text/csv, text/tab-separated-values or text/plain) with the profile in the query
      imports: '/finance/bank-imports',
      importById: (id: string) => `/finance/bank-imports/${id}`,
      importLines: (id: string) => `/finance/bank-imports/${id}/lines`,
      // POST confirms, in one go, every line whose match is the only one and an exact one
      confirmExact: (id: string) => `/finance/bank-imports/${id}/confirm-exact`,
      // The balance of the books against the balance the statement ended with
      difference: (id: string) => `/finance/bank-imports/${id}/difference`,
      // POST confirms the pair of a statement line and a line of the journal
      lineMatches: (id: string) => `/finance/bank-lines/${id}/matches`,
      // POST confirms ONE statement line against SEVERAL lines of the journal whose signed sum is exactly its amount (HC-121)
      lineGroupMatches: (id: string) => `/finance/bank-lines/${id}/group-matches`,
      // GET: the lines of the books of the account of a statement line that nothing matched, newest first: what a group is chosen from (HC-121)
      lineBookCandidates: (id: string) => `/finance/bank-lines/${id}/book-candidates`,
      lineRejections: (id: string) => `/finance/bank-lines/${id}/rejections`,
      // GET: the transaction of 4B.4a an unmatched line would be, prefilled (nothing is posted)
      lineRegisterDraft: (id: string) => `/finance/bank-lines/${id}/register-draft`,
      // POST takes a decision back (a confirmed pair or a rejection)
      matchUndo: (id: string) => `/finance/bank-matches/${id}/undo`,
      // The state of the reconciliation of an account in a month
      status: '/finance/bank-reconciliation/status'
    },
    balances: '/finance/balances',
    // The sources whose automatic entry failed, still waiting for a person (TDD_18 §6.1)
    postings: '/finance/postings',
    // POST posts the entry of a failed source again, now: the person fixed what failed (a mapping, an account)
    postingRetry: (id: string) => `/finance/postings/${id}/retry`
  },

  // Fiscal documents (TDD_18 §8, §12): the issuer of the ORGANIZATION and the documents of its sales
  fiscal: {
    // What the deployment's providers declare (document types, the fields they need), never a credential
    providers: '/fiscal/providers',
    // GET the issuer without credentials; PUT sets it (credentials are written, never read)
    issuer: '/fiscal/issuer',
    // GET the series of correlatives of the organization: what each counts and the number the next document takes (Step 4B.7c-5)
    series: '/fiscal/series',
    // GET the dry run of the daily check of the documents (Step 4B.8b-2b): the findings of one kind, a page at a time. It changes nothing
    reconciliation: '/fiscal/reconciliation',
    // The contingency of the issuer (Step 4B.7c-7): GET the open one, POST starts one, POST /end ends it; the list of them; the report asked again
    contingency: {
      current: '/fiscal/contingency',
      end: '/fiscal/contingency/end',
      list: '/fiscal/contingencies',
      report: (id: string) => `/fiscal/contingencies/${id}/report`,
      abandon: (id: string) => `/fiscal/contingencies/${id}/abandon`
    },
    documents: {
      list: '/fiscal/documents',
      byId: (id: string) => `/fiscal/documents/${id}`,
      // PATCH the receiver of a document that is queued or rejected: a person fixes the data the authority refused
      receiver: (id: string) => `/fiscal/documents/${id}/receiver`,
      retry: (id: string) => `/fiscal/documents/${id}/retry`,
      void: (id: string) => `/fiscal/documents/${id}/void`,
      // POST makes the sale document again after the one before was voided (and the credit notes that were voided with it)
      replace: (id: string) => `/fiscal/documents/${id}/replace`,
      // GET the signed link of one file of evidence of a document (`document`, `response`, `void_response`): short-lived, clean files only
      evidence: (id: string, kind: string) => `/fiscal/documents/${id}/evidence/${kind}`,
      // POST: a person confirms that a document that may be at the issuer it was made with is not there, so it is made again with the
      // issuer as it is now (the authority's answer is the person's, with the accountant)
      confirmIssuerChange: (id: string) => `/fiscal/documents/${id}/confirm-issuer-change`
    },
    // The fiscal data of a customer of the store of X-Store-Id: GET masked, PUT replaces what is sent, DELETE clears it
    customerData: {
      get: (customerId: string) => `/customers/${customerId}/fiscal`,
      put: (customerId: string) => `/customers/${customerId}/fiscal`,
      clear: (customerId: string) => `/customers/${customerId}/fiscal`
    }
  },

  // Suppliers and what is owed to them (TDD_18 §2.7, §12): organization-scoped like the books they post to. A route is a leaf of
  // its own (the same path with another verb is another leaf), because each one is mapped to the step that draws it.
  suppliers: {
    list: '/suppliers',
    create: '/suppliers',
    byId: (id: string) => `/suppliers/${id}`,
    update: (id: string) => `/suppliers/${id}`,
    // The accounts payable: every bill with something open, with its due date, and the total per supplier
    payables: '/suppliers/payables',
    balance: (id: string) => `/suppliers/${id}/balance`,
    payments: (id: string) => `/suppliers/${id}/payments`,
    recordPayment: (id: string) => `/suppliers/${id}/payments`
  },
  supplierPayments: {
    void: (id: string) => `/supplier-payments/${id}/void`,
    // POST records what the supplier gave back of this payment; GET lists the returns of the payment (HC-121)
    returns: (id: string) => `/supplier-payments/${id}/returns`
  },
  supplierPaymentReturns: {
    void: (id: string) => `/supplier-payment-returns/${id}/void`
  },
  purchaseOrders: {
    list: '/purchase-orders',
    create: '/purchase-orders',
    byId: (id: string) => `/purchase-orders/${id}`,
    update: (id: string) => `/purchase-orders/${id}`,
    order: (id: string) => `/purchase-orders/${id}/order`,
    receive: (id: string) => `/purchase-orders/${id}/receive`,
    close: (id: string) => `/purchase-orders/${id}/close`,
    cancel: (id: string) => `/purchase-orders/${id}/cancel`,
    payments: (id: string) => `/purchase-orders/${id}/payments`,
    recordPayment: (id: string) => `/purchase-orders/${id}/payments`
  },

  // Shipping (TDD_17 §6)
  carriers: {
    list: '/carriers',
    create: '/carriers',
    registry: '/carriers/registry', // Which official carriers exist and their capabilities
    byId: (id: string) => `/carriers/${id}`,
    test: (id: string) => `/carriers/${id}/test`,
    disconnect: (id: string) => `/carriers/${id}/disconnect`,
    webhookSecret: (id: string) => `/carriers/${id}/webhook-secret`, // POST makes a new secret, shown once
    locations: (id: string) => `/carriers/${id}/locations`, // ?parentId=&search=
    statusCatalog: (id: string) => `/carriers/${id}/status-catalog`, // What the plugin knows of its codes, with the row each has
    statusMappings: (id: string) => `/carriers/${id}/status-mappings`,
    statusMappingByCode: (id: string, code: string) => `/carriers/${id}/status-mappings/${code}`, // PUT maps it, DELETE restores the plugin default
    unmappedStatuses: (id: string) => `/carriers/${id}/unmapped-statuses`,
    // The balance of prepaid guides and the refund benefit of a connection (TDD_17 §4.18)
    guideBalance: (id: string) => `/carriers/${id}/guide-balance`,
    guideMovements: (id: string) => `/carriers/${id}/guide-movements`,
    guidePurchases: (id: string) => `/carriers/${id}/guide-purchases`, // POST records a purchase
    guidePurchaseVoid: (id: string, movementId: string) =>
      `/carriers/${id}/guide-purchases/${movementId}/void`,
    guideAdjustments: (id: string) => `/carriers/${id}/guide-adjustments`,
    guidePolicy: (id: string) => `/carriers/${id}/guide-policy`, // GET reads it, PUT replaces it
    benefit: (id: string) => `/carriers/${id}/benefit`, // The rate and the state of the current period
    benefitPeriods: (id: string) => `/carriers/${id}/benefit-periods` // The periods the daily close judged
  },

  shipments: {
    list: '/shipments',
    byId: (id: string) => `/shipments/${id}`,
    forOrder: (orderId: string) => `/orders/${orderId}/shipments`, // POST creates the guide
    bulk: '/shipments/bulk', // At most 100 ids, answers 202 with the job id
    bulkJob: (jobId: string) => `/shipments/bulk/${jobId}`,
    mergeLabels: '/shipments/labels/merge',
    label: (id: string) => `/shipments/${id}/label`,
    cancel: (id: string) => `/shipments/${id}/cancel`,
    status: (id: string) => `/shipments/${id}/status`, // A manual event
    check: (id: string) => `/shipments/${id}/check`, // Ask the carrier
    markVoided: (id: string) => `/shipments/${id}/mark-voided`
  },

  pickups: {
    list: '/pickups',
    create: '/pickups', // Request now, with the chosen shipments
    shipments: (id: string) => `/pickups/${id}/shipments`,
    shipmentById: (id: string, shipmentId: string) => `/pickups/${id}/shipments/${shipmentId}`,
    confirm: (id: string) => `/pickups/${id}/confirm`, // Manual
    cancel: (id: string) => `/pickups/${id}/cancel`,
    manifest: (id: string) => `/pickups/${id}/manifest` // Printable list
  },

  orderTemplates: {
    list: '/order-templates',
    preview: '/order-templates/preview', // POST: the body being edited, rendered with a sample order
    byKindAndLocale: (kind: string, locale: string) => `/order-templates/${kind}/locales/${locale}` // GET, PUT (upsert), DELETE
  },

  returns: {
    list: '/returns',
    create: '/returns',
    byId: (id: string) => `/returns/${id}`,
    approve: (id: string) => `/returns/${id}/approve`,
    reject: (id: string) => `/returns/${id}/reject`,
    cancel: (id: string) => `/returns/${id}/cancel`,
    inTransit: (id: string) => `/returns/${id}/in-transit`,
    receive: (id: string) => `/returns/${id}/receive`, // With the line conditions
    complete: (id: string) => `/returns/${id}/complete`,
    returnShipment: (id: string) => `/returns/${id}/return-shipment`,
    reception: {
      batches: '/returns/reception/batches',
      batchById: (id: string) => `/returns/reception/batches/${id}`,
      scan: (id: string) => `/returns/reception/batches/${id}/scan`, // A code
      itemById: (id: string, itemId: string) => `/returns/reception/batches/${id}/items/${itemId}`,
      complete: (id: string) => `/returns/reception/batches/${id}/complete`
    }
  },

  remittances: {
    list: '/remittances',
    byId: (id: string) => `/remittances/${id}`,
    imports: '/remittances/imports', // A file or pasted text; creates a draft
    pending: '/remittances/pending',
    lines: (id: string) => `/remittances/${id}/lines`,
    lineById: (id: string, lineId: string) => `/remittances/${id}/lines/${lineId}`,
    confirm: (id: string) => `/remittances/${id}/confirm`,
    void: (id: string) => `/remittances/${id}/void`,
    // Writes off the difference of a guide that did not match its remittance (by the id of the guide); the books work out the amount
    writeOff: (shipmentId: string) => `/remittances/discrepancies/${shipmentId}/write-off`,
    // A table pasted or a sample of a file, read with the mapping being tried: writes nothing (the mapper's preview)
    importPreview: '/remittances/imports/preview',
    importProfiles: '/remittances/import-profiles',
    importProfileById: (id: string) => `/remittances/import-profiles/${id}`
  },

  media: {
    uploadUrl: '/media/upload-url',
    confirmUpload: '/media/confirm-upload',
    byId: (id: string) => `/media/${id}`,
    downloadAll: '/media/download-all'
  },

  exports: {
    list: '/exports',
    byId: (id: string) => `/exports/${id}`,
    download: (id: string) => `/exports/${id}/download`
  },

  search: {
    global: '/search',
    messages: '/search/messages',
    customers: '/search/customers',
    orders: '/search/orders',
    products: '/search/products',
    // The result a person opened (POST)
    clicks: '/search/clicks'
  },

  notifications: {
    list: '/notifications',
    unreadCount: '/notifications/unread-count',
    markRead: '/notifications/read',
    markAllRead: '/notifications/read-all',
    preferences: '/notifications/preferences',
    pushSubscription: '/notifications/push-subscription',
    // A POST and not a DELETE with a body, which proxies and fetch wrappers drop
    pushSubscriptionRemove: '/notifications/push-subscription/remove',
    // The one-click unsubscribe of the notification emails (Step 7.3, B6b-3b2b). PUBLIC: no session, the signed token is the credential. POST
    // only: a GET that changed state would be fired by every mail scanner that opens the links of a message
    unsubscribe: '/notifications/unsubscribe'
  },

  analytics: {
    metrics: '/analytics/metrics',
    myPerformance: '/analytics/my-performance',
    reports: '/analytics/reports',
    reportById: (id: string) => `/analytics/reports/${id}`,
    export: '/analytics/export',
    // What was searched: volume, zero results, clicks and the texts nobody found (GET)
    search: '/analytics/search'
  },

  plugins: {
    available: '/plugins/available',
    install: '/plugins/install',
    register: '/plugins/register', // The owner pastes a manifest (SETTINGS_MANAGE_PLUGINS)
    byId: (id: string) => `/plugins/${id}`, // One plugin of the catalog and what this store holds of it (GET), or removes a plugin of the organization (DELETE); the id is the plugin's
    revoke: (id: string) => `/plugins/${id}/revoke`, // Uninstalls: the id is the installation's
    consent: (id: string) => `/plugins/${id}/consent`, // What installing the plugin of that id would grant (GET); the id is the plugin's
    setupCode: (id: string) => `/plugins/${id}/setup-code`, // A new one-time code for an installation that is not set up yet (POST); the id is the installation's
    commandSecret: (id: string) => `/plugins/${id}/command-secret`, // Rotates the secret that signs the commands to a remote channel (POST); the id is the installation's
    apiKey: (id: string) => `/plugins/${id}/api-key` // Rotates the API key of an installation (POST): the old key stops working at once and the new one is shown once; the id is the installation's
  },

  // The widgets of the plugins in the agent sidebar (TDD_10 §7): the ones the store has, a short session
  // for one conversation, and the bridge the page forwards what a widget asks over its port to
  pluginWidgets: {
    list: '/plugin-widgets',
    sessions: '/plugin-widgets/sessions',
    bridge: '/plugin-widgets/bridge',
    // Settings → Plugins: every widget of the store with whether the agents see it (GET), and show or hide one (PUT)
    settings: '/plugin-widgets/settings',
    visibility: (installationId: string, widgetId: string) =>
      `/plugin-widgets/settings/${installationId}/widget/${widgetId}`
  },

  channels: {
    connections: '/channels/connections',
    // The same accounts for anyone who may see conversations: the inbox names a channel and decides
    // what to draw with it. It carries no error text, no date and no credential
    directory: '/channels/directory',
    connect: (pluginId: string) => `/channels/${pluginId}/connect`,
    connectionById: (id: string) => `/channels/connections/${id}`,
    // The text a plugin gave for a failed check, cleaned (GET). Only for whoever manages plugins: the connection itself carries
    // a code of ours and never the words of a third party
    connectionErrorDetail: (id: string) => `/channels/connections/${id}/error-detail`,
    test: (id: string) => `/channels/connections/${id}/test`,
    disconnect: (id: string) => `/channels/connections/${id}/disconnect`,
    // Replaces the token of one connection, checked against the account it already has
    updateToken: (id: string) => `/channels/connections/${id}/token`,
    // The name the owner gives to one connection
    label: (id: string) => `/channels/connections/${id}/label`,
    templates: (pluginId: string) => `/channels/${pluginId}/templates`,
    // The web widget's own settings: the sites that may load it and the snippet to paste
    widgetEmbed: (id: string) => `/channels/connections/${id}/widget`,
    widgetOrigins: (id: string) => `/channels/connections/${id}/widget/origins`,
    // Turns the pre-chat form of the widget on or off
    widgetPreChat: (id: string) => `/channels/connections/${id}/widget/pre-chat`,
    // "Connect with Facebook" (Step 7.8). `oauthStart` makes the state and returns the address of the
    // dialog; `oauthCallback` is where the provider sends the browser back (PUBLIC: it carries no
    // headers of ours, so everything it may do rests on the state); the rest list the Pages of one
    // session, finish it with the chosen one, or drop it
    oauthStart: (pluginId: string) => `/channels/connections/oauth/${pluginId}/start`,
    oauthCallback: '/channels/oauth/callback',
    oauthAssets: (sessionId: string) => `/channels/connections/oauth/sessions/${sessionId}/assets`,
    oauthComplete: (sessionId: string) =>
      `/channels/connections/oauth/sessions/${sessionId}/complete`,
    oauthSession: (sessionId: string) => `/channels/connections/oauth/sessions/${sessionId}`
  },

  // Who of the team is connected to the store of the request, read once when the inbox opens; the
  // sockets keep it current after that
  presence: {
    team: '/presence'
  },

  // Who the active members of the store are, for anyone who may see conversations: the inbox names
  // an assignee, a mention and the author of a note with it. It carries no email, status or permission
  members: {
    directory: '/members'
  },

  settings: {
    inbox: '/settings/inbox',
    // Read-only, for who works the inbox: how resolving behaves and the timezone the snooze presets use
    inboxBehavior: '/settings/inbox/behavior',
    safety: '/settings/safety',
    preferences: '/settings/preferences', // GET, and PUT of the keys that change (the others keep their value)
    // Settings → Inventory (TDD_16 §4.10): GET, and PATCH of the switches that change
    inventory: '/settings/inventory',
    // Settings → Returns (TDD_17 §4.14): GET, and PATCH of who pays the return leg by default
    returns: '/settings/returns',
    members: '/settings/team/members',
    memberById: (id: string) => `/settings/team/members/${id}`,
    // POST: the member keeps the role and the history but cannot enter the store until reactivated
    memberSuspend: (id: string) => `/settings/team/members/${id}/suspend`,
    memberReactivate: (id: string) => `/settings/team/members/${id}/reactivate`,
    invitations: '/settings/team/invitations',
    invitationById: (id: string) => `/settings/team/invitations/${id}`,
    // POST: a new token, the old link stops working and the email goes out again
    invitationResend: (id: string) => `/settings/team/invitations/${id}/resend`,
    roles: '/settings/roles',
    roleById: (id: string) => `/settings/roles/${id}`,
    routing: '/settings/routing',
    routingOrder: '/settings/routing/order', // PATCH, declared before routingRuleById
    routingRuleById: (id: string) => `/settings/routing/${id}`,
    businessHours: '/settings/business-hours',
    tags: '/settings/tags',
    tagById: (id: string) => `/settings/tags/${id}`,
    snippets: '/settings/snippets',
    snippetById: (id: string) => `/settings/snippets/${id}`,
    webhooks: '/settings/webhooks',
    webhookById: (id: string) => `/settings/webhooks/${id}`,
    webhookDeliveries: (id: string) => `/settings/webhooks/${id}/deliveries`,
    webhookSecret: (id: string) => `/settings/webhooks/${id}/secret`, // POST makes a new secret, shown once
    apiKeys: '/settings/api-keys',
    apiKeyById: (id: string) => `/settings/api-keys/${id}`,
    retention: '/settings/retention'
  },

  account: {
    profile: '/account/profile', // GET and PATCH: the name and the picture
    preferences: '/account/preferences', // GET and PATCH: locale, timezone and density
    // The picture of the person, apart from the store's media routes: no X-Store-Id, no permission.
    // Attaching it and taking it away is `PATCH /account/profile` with the media id or null
    avatarUploadUrl: '/account/avatar/upload-url', // POST: a signed url to PUT the file to
    avatarConfirm: '/account/avatar/confirm' // POST: the file is there; it is scanned and re-encoded
  },

  compliance: {
    dsr: '/compliance/dsr',
    dsrById: (id: string) => `/compliance/dsr/${id}`,
    dsrApprove: (id: string) => `/compliance/dsr/${id}/approve`,
    dsrReject: (id: string) => `/compliance/dsr/${id}/reject`,
    dsrCancel: (id: string) => `/compliance/dsr/${id}/cancel`,
    dsrExport: (id: string) => `/compliance/dsr/${id}/export`, // The signed link to the file of a finished access or portability request
    dsrVerify: '/compliance/dsr/verify', // Public, token in body
    dsrForm: '/compliance/dsr-form', // The public form of the store: its key and whether it is on (customers:dsr_manage_form)
    dsrFormKey: '/compliance/dsr-form/key', // POST makes the first key or replaces the one the screen showed
    dsrFormKeyRevoke: '/compliance/dsr-form/key/revoke', // POST switches the form off
    consent: '/compliance/consent',
    cookieConsent: '/compliance/cookie-consent'
  },

  // Public, unauthenticated. No AuthGuard/TenantGuard; each has its own verification.
  webhooks: {
    resend: '/webhooks/resend',
    channel: (pluginId: string) => `/webhooks/channels/${pluginId}`,
    carrier: (connectionId: string) => `/webhooks/carriers/${connectionId}` // The signature authenticates it
  },

  // Web widget public API (visitor-facing, signed with the site key). TDD_10 §5.4
  widget: {
    bootstrap: '/widget/bootstrap',
    messages: '/widget/messages',
    upload: '/widget/upload-url',
    // The signed link of one file of the visitor's own conversation
    download: '/widget/download-url'
  }
} as const

// The routes a plugin calls with its own key (TDD_10 §6.4), under the same /api/v1 prefix. They are not in `ApiRoutes` because
// they are not the routes of the interface: `ApiRoutes` is what the web draws and what `pnpm validate:plugin-api` asks a plugin
// scope for, and these are what that check points to (`exposed: '/plugin-api/...'` of scripts/plugin-api-coverage-map.ts must
// be one of them). Every path starts with /plugin-api/, and a test refuses a plugin-api controller route that is not listed here.
export const PluginApiRoutes = {
  // A plugin that was just installed trades its one-time code for its key. Public: it has no key yet, and the code is the
  // credential (256 bits, five minutes, used once).
  setupExchange: '/plugin-api/setup/exchange',
  // Who the key is: its installation, its store and its scopes (any active key, no scope needed)
  installation: '/plugin-api/installation',

  // Step 5.6 PR E1: the conversations of the store (the same services as `ApiRoutes.conversations`). `list` is also the path of
  // the one route with no human counterpart, POST, that starts a conversation.
  conversations: {
    list: '/plugin-api/conversations',
    bulk: '/plugin-api/conversations/bulk',
    byId: (id: string) => `/plugin-api/conversations/${id}`,
    origins: (id: string) => `/plugin-api/conversations/${id}/origins`,
    messagingWindow: (id: string) => `/plugin-api/conversations/${id}/messaging-window`,
    assign: (id: string) => `/plugin-api/conversations/${id}/assign`,
    status: (id: string) => `/plugin-api/conversations/${id}/status`,
    snooze: (id: string) => `/plugin-api/conversations/${id}/snooze`,
    tags: (id: string) => `/plugin-api/conversations/${id}/tags`,
    tagById: (id: string, tagId: string) => `/plugin-api/conversations/${id}/tags/${tagId}`,
    read: (id: string) => `/plugin-api/conversations/${id}/read`,
    unread: (id: string) => `/plugin-api/conversations/${id}/unread`
  },

  // Step 5.6 PR E2: the customers of the store (the same services as `ApiRoutes.customers`). `list` is also the path of the POST
  // that creates one. Not here, on purpose: the notes that a plugin would write (an author is a person), the merge, its undo and
  // its preview, the gallery and the export (PR E7).
  customers: {
    list: '/plugin-api/customers',
    byId: (id: string) => `/plugin-api/customers/${id}`,
    caution: (id: string) => `/plugin-api/customers/${id}/caution`,
    identities: (id: string) => `/plugin-api/customers/${id}/identities`,
    identityById: (id: string, identityId: string) =>
      `/plugin-api/customers/${id}/identities/${identityId}`,
    timeline: (id: string) => `/plugin-api/customers/${id}/timeline`,
    orders: (id: string) => `/plugin-api/customers/${id}/orders`,
    conversations: (id: string) => `/plugin-api/customers/${id}/conversations`,
    notes: (id: string) => `/plugin-api/customers/${id}/notes`,
    addresses: (id: string) => `/plugin-api/customers/${id}/addresses`,
    addressById: (id: string, addressId: string) =>
      `/plugin-api/customers/${id}/addresses/${addressId}`,
    tags: (id: string) => `/plugin-api/customers/${id}/tags`,
    tagById: (id: string, tagId: string) => `/plugin-api/customers/${id}/tags/${tagId}`
  },

  search: {
    messages: '/plugin-api/search/messages',
    customers: '/plugin-api/search/customers',
    orders: '/plugin-api/search/orders',
    products: '/plugin-api/search/products'
  },

  channels: {
    directory: '/plugin-api/channels/directory',
    templates: (pluginId: string) => `/plugin-api/channels/${pluginId}/templates`
  },
  // Step 5.6 PR C3 (TDD_10 §6.7.5): what a remote CHANNEL plugin says to the platform, about its own accounts and about what
  // its customers write. There is no human counterpart: a person links an account in the plugin's settings page
  channel: {
    connection: (connectionId: string) => `/plugin-api/channel/connections/${connectionId}`,
    events: '/plugin-api/channel/events'
  },

  // Step 5.6 PR E3a: the reading of orders, over the same services as `ApiRoutes.orders` and `ApiRoutes.orderTemplates`. Their
  // writes need the id of a person (who confirmed, who cancelled, who created) and wait for a plugin actor (PR E3b).
  orders: {
    list: '/plugin-api/orders',
    create: '/plugin-api/orders',
    byId: (id: string) => `/plugin-api/orders/${id}`,
    messages: (id: string) => `/plugin-api/orders/${id}/messages`,
    // Step 5.6 PR E3b: the writes, over the same services as the routes of the people, with the plugin as the actor (`ActorIdentity`)
    status: (id: string) => `/plugin-api/orders/${id}/status`,
    confirmBulk: '/plugin-api/orders/confirm-bulk',
    copy: (id: string) => `/plugin-api/orders/${id}/copy`,
    confirm: (id: string) => `/plugin-api/orders/${id}/confirm`,
    cancel: (id: string) => `/plugin-api/orders/${id}/cancel`,
    payment: (id: string) => `/plugin-api/orders/${id}/payment`,
    priceApprovalApprove: (id: string) => `/plugin-api/orders/${id}/price-approval/approve`,
    priceApprovalReject: (id: string) => `/plugin-api/orders/${id}/price-approval/reject`
  },
  orderTemplates: {
    list: '/plugin-api/order-templates',
    preview: '/plugin-api/order-templates/preview',
    byKindAndLocale: (kind: string, locale: string) =>
      `/plugin-api/order-templates/${kind}/locales/${locale}`
  },

  // Step 5.6 PR E3a: the store preferences and the return rules, read only
  settings: {
    preferences: '/plugin-api/settings/preferences',
    returns: '/plugin-api/settings/returns',
    // Step 5.6 PR E4a-2: the tag catalog of the store
    tags: '/plugin-api/settings/tags',
    tagById: (id: string) => `/plugin-api/settings/tags/${id}`,
    // Step 5.6 PR E7-2: the canned replies of the store, read only
    snippets: '/plugin-api/settings/snippets',
    snippetById: (id: string) => `/plugin-api/settings/snippets/${id}`
  },

  // Step 5.6 PR E4a: the catalog and the stock, over the same services as `ApiRoutes.products`, `.inventory` and `.warehouses`. The
  // adjustment of stock (PR E4a-2) is recorded with the plugin actor of PR M1c.
  products: {
    list: '/plugin-api/products',
    create: '/plugin-api/products',
    byId: (id: string) => `/plugin-api/products/${id}`,
    variants: (id: string) => `/plugin-api/products/${id}/variants`,
    images: (id: string) => `/plugin-api/products/${id}/images`,
    variantById: (id: string, variantId: string) =>
      `/plugin-api/products/${id}/variants/${variantId}`,
    search: '/plugin-api/products/search',
    inventory: (id: string) => `/plugin-api/products/${id}/inventory`
  },
  warehouses: {
    list: '/plugin-api/warehouses',
    byId: (id: string) => `/plugin-api/warehouses/${id}`
  },
  inventory: {
    levels: '/plugin-api/inventory/levels',
    summary: '/plugin-api/inventory/summary',
    movements: '/plugin-api/inventory/movements',
    kardex: '/plugin-api/inventory/kardex',
    adjustments: '/plugin-api/inventory/adjustments'
  },
  // Step 5.6 PR E4b and E4b-2: the transfers between warehouses and the physical counts, over the same services as
  // `ApiRoutes.transfers` and `.counts`. The change of a draft transfer is the PATCH of `byId`, the lines of a count the PATCH of
  // `lines`.
  transfers: {
    list: '/plugin-api/transfers',
    create: '/plugin-api/transfers',
    byId: (id: string) => `/plugin-api/transfers/${id}`,
    dispatch: (id: string) => `/plugin-api/transfers/${id}/dispatch`,
    receive: (id: string) => `/plugin-api/transfers/${id}/receive`,
    close: (id: string) => `/plugin-api/transfers/${id}/close`,
    cancel: (id: string) => `/plugin-api/transfers/${id}/cancel`
  },
  counts: {
    list: '/plugin-api/counts',
    create: '/plugin-api/counts',
    byId: (id: string) => `/plugin-api/counts/${id}`,
    start: (id: string) => `/plugin-api/counts/${id}/start`,
    lines: (id: string) => `/plugin-api/counts/${id}/lines`,
    submit: (id: string) => `/plugin-api/counts/${id}/submit`,
    reopen: (id: string) => `/plugin-api/counts/${id}/reopen`,
    apply: (id: string) => `/plugin-api/counts/${id}/apply`,
    cancel: (id: string) => `/plugin-api/counts/${id}/cancel`
  },
  // Step 5.6 PR E6: the reads of the returns (and of the batches of the scanner that receives them) and of the remittances of
  // cash collected on delivery, over the same services as `ApiRoutes.returns` and `.remittances`. Their writes store the id of a
  // person, move stock or move money, and wait for PR E6-2 and the plugin actor.
  returns: {
    list: '/plugin-api/returns',
    byId: (id: string) => `/plugin-api/returns/${id}`,
    reception: {
      batches: '/plugin-api/returns/reception/batches',
      batchById: (id: string) => `/plugin-api/returns/reception/batches/${id}`
    }
  },
  remittances: {
    list: '/plugin-api/remittances',
    pending: '/plugin-api/remittances/pending',
    importProfiles: '/plugin-api/remittances/import-profiles',
    byId: (id: string) => `/plugin-api/remittances/${id}`
  },
  // Step 5.6 PR E5: the reads of the shipments, the carrier connections and the pickups, over the same services as
  // `ApiRoutes.shipments`, `.carriers` and `.pickups`. The writes (a guide spends the prepaid balance, a pickup is a promise made
  // to a carrier) and the label link wait for PR E5-2.
  shipments: {
    list: '/plugin-api/shipments',
    byId: (id: string) => `/plugin-api/shipments/${id}`
  },
  carriers: {
    list: '/plugin-api/carriers',
    registry: '/plugin-api/carriers/registry',
    byId: (id: string) => `/plugin-api/carriers/${id}`,
    statusCatalog: (id: string) => `/plugin-api/carriers/${id}/status-catalog`,
    unmappedStatuses: (id: string) => `/plugin-api/carriers/${id}/unmapped-statuses`
  },
  pickups: {
    list: '/plugin-api/pickups',
    manifest: (id: string) => `/plugin-api/pickups/${id}/manifest`
  },

  // Step 5.6 PR E7: the figures of the store, the exports centre of the key and the files, over the same services as
  // `ApiRoutes.analytics`, `.exports` and `.media`. Not here, on purpose: the scheduled reports (their recipients are people's
  // addresses) and the other kinds of export (PR E7-2).
  analytics: {
    metrics: '/plugin-api/analytics/metrics',
    export: '/plugin-api/analytics/export'
  },
  exports: {
    list: '/plugin-api/exports',
    byId: (id: string) => `/plugin-api/exports/${id}`,
    download: (id: string) => `/plugin-api/exports/${id}/download`
  },
  media: {
    uploadUrl: '/plugin-api/media/upload-url',
    confirmUpload: '/plugin-api/media/confirm-upload',
    byId: (id: string) => `/plugin-api/media/${id}`,
    downloadAll: '/plugin-api/media/download-all'
  },

  // Messages (Step 5.6 PR M1b): a plugin writes a reply or a note, and reads the edits and the kept text of a deleted message
  messages: {
    create: '/plugin-api/messages',
    // PATCH (edit its own message or note) and DELETE (delete its own)
    byId: (id: string) => `/plugin-api/messages/${id}`,
    resend: (id: string) => `/plugin-api/messages/${id}/resend`,
    discard: (id: string) => `/plugin-api/messages/${id}/discard`,
    reaction: (id: string) => `/plugin-api/messages/${id}/reaction`,
    resendCaption: (id: string) => `/plugin-api/messages/${id}/resend-caption`,
    refetchFile: (id: string, index: number | string) =>
      `/plugin-api/messages/${id}/files/${index}/refetch`,
    deletedContent: (id: string) => `/plugin-api/messages/${id}/deleted-content`,
    revisions: (id: string) => `/plugin-api/messages/${id}/revisions`
  }
} as const

// Mounted OUTSIDE the /api/v1 prefix.
export const InfraRoutes = {
  healthLive: '/health',
  healthReady: '/health/ready',
  metrics: '/metrics',
  docs: '/docs',
  queues: '/admin/queues' // Bull Board, behind the JWT + BULL_BOARD_ADMIN_EMAILS middleware
} as const
