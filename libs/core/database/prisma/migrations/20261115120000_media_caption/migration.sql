-- The text under each file of a message an agent sends. Until now the message held one text (the one under
-- the first file); now each file keeps its own, with the state of its text for the channels that send it as a
-- message of its own (Instagram and Messenger) and the id of that message, so that the echo of the provider
-- finds it and is not stored as a message of the owner. `messages.content` stays the text under the first
-- file. Text of the agent: never logged. Files sent before this have no caption of their own (null).
ALTER TABLE "media"
  ADD COLUMN "caption" TEXT,
  ADD COLUMN "caption_state" TEXT,
  ADD COLUMN "caption_channel_message_id" TEXT;

CREATE INDEX "media_store_id_caption_channel_message_id_idx"
  ON "media" ("store_id", "caption_channel_message_id");
