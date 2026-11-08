-- The state of the text under a file, and the provider id of the message that carried it, were kept on the
-- `media` row for the channels that send the text of each file as a message of its own. Only a channel that
-- carries the text with its file (`CAPTION_PER_FILE`) takes a text per file now, and the state and the id of
-- the text of a message (under its first file) live on `messages`. Nothing writes or reads these two columns
-- any more. `media.caption` (the text itself) stays. No data is moved: the app has no users yet.
-- Deploy order: run it only after every pod of the code that still lists these columns is gone (the release of
-- #315 first, then this one): an old client selects them in every `media` query. Dropping the columns drops the
-- index on `caption_channel_message_id` with them.
ALTER TABLE "media"
  DROP COLUMN "caption_channel_message_id",
  DROP COLUMN "caption_state";
