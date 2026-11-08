-- A customer message and the unassigned queue push by default now (owner, 2026-11-08; NotificationDefaults
-- in libs/core/domain/notifications). A person who saved either row before has all four channels stored,
-- the old default among them, so the new default would never reach them. A row that holds EXACTLY the old
-- default tells nothing the default does not, so it is removed and the new default applies. Any other
-- combination (an email chosen, a sound turned off, a push already on) is a choice and stays untouched,
-- and so does every other type, even with the same four values.
-- Known consequence, accepted (single owner in the MVP): someone who chose exactly the old default on
-- purpose (no push for the queue) gets the push now and turns it off in one click; it cannot be told
-- from a default. The rows are per user and store, but nothing here depends on a store: the migrator owns
-- the table and needs no privilege beyond the DELETE.
DO $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM notification_preferences
  WHERE (type = 'message.received' AND in_app AND NOT push AND NOT email AND sound)
     OR (type = 'conversation.unassigned_queue' AND in_app AND NOT push AND NOT email AND NOT sound);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'notification_preferences: % row(s) equal to the old default removed', removed;
END
$$;
