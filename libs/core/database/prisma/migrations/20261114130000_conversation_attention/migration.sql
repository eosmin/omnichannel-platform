-- A mark that raises a conversation in the list until someone opens it (a snoozed conversation that woke
-- up is the first use), and the reminder an agent can leave when snoozing. The mark has a reason so that
-- another notice can use it later without a new column. Text of the agent: the note is capped by the api
-- (ConversationLimits.SNOOZE_NOTE_MAX_LENGTH), not here, and never goes to logs or events.
ALTER TABLE "conversations"
  ADD COLUMN "snooze_note" TEXT,
  ADD COLUMN "attention_reason" TEXT,
  ADD COLUMN "attention_at" TIMESTAMP(3),
  ADD COLUMN "attention_note" TEXT;

-- The list of a store orders by (attention_at, last_message_at, id) and is the hottest query: this index
-- serves that order whole. Prisma cannot say NULLS LAST on an index, so it is raw (as the partial ones of
-- the raw_sql migration).
CREATE INDEX "conversations_store_list_order_idx"
  ON "conversations" ("store_id", "attention_at" DESC NULLS LAST, "last_message_at" DESC NULLS LAST, "id" DESC);

-- Only the few rows that carry a mark: finding them (a count, the rows to clear) does not scan the store
CREATE INDEX "conversations_attention_idx"
  ON "conversations" ("store_id", "attention_at" DESC)
  WHERE "attention_at" IS NOT NULL;
