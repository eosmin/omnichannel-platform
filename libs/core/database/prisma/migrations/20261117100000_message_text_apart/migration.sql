-- Where the channel carries a text under each file (WhatsApp), the text of the composer is no longer the text
-- under the first file: every file has its own (`media.caption`) and the text of the message (`messages.content`)
-- is sent as a message of its own after the last file. This says which of the two a message is. Every message
-- sent before keeps false: its `content` is the text under its first file. Text of the agent: never logged.
ALTER TABLE "messages"
  ADD COLUMN "text_apart" BOOLEAN NOT NULL DEFAULT false;
