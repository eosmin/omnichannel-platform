// The files that go when conversations go: those of their messages and the pictures of the ads they came from. One rule for the manual
// deletion of a conversation (`ConversationDeletionService`) and for the nightly retention (`StoreRetentionEnforcer`), so the two can never
// disagree about what a deleted conversation takes with it.
//
// The documents of an order (its summary or its label, sent in the conversation as a message) belong to the order, not to the conversation: they
// have an `orderId`, so they are never named here and keep their row and their objects. The `message` link that they lose is the
// foreign key's own (`Media.message` is SET NULL when the message goes). TDD_05 §10.4: orders are never touched by the retention of a tenant.
// The same goes for a file that belongs to the books (a receipt of a transaction, the evidence of a fiscal document): it is never the conversation's.
export interface ConversationFilesWhere {
  storeId: string
  orderId: null
  financeTransactionId: null
  fiscalDocumentId: null
  OR: [
    { message: { conversationId: { in: string[] } } },
    { origin: { conversationId: { in: string[] } } }
  ]
}

export function filesOfConversationsWhere(
  storeId: string,
  conversationIds: readonly string[]
): ConversationFilesWhere {
  const ids = [...conversationIds]
  return {
    storeId,
    orderId: null,
    financeTransactionId: null,
    fiscalDocumentId: null,
    OR: [{ message: { conversationId: { in: ids } } }, { origin: { conversationId: { in: ids } } }]
  }
}
