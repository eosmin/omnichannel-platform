-- The trace of a message a plugin wrote (Step 5.6, PR M1a): the plugin, always, and the nickname it chose when it wrote as the
-- system. Both are null for every existing message. Nullable columns with no default are added without rewriting the table; there is
-- no foreign key on purpose (it would scan `messages` to be added), the route takes the id from the installation of the key.
ALTER TABLE "messages" ADD COLUMN "author_plugin_id" TEXT;
ALTER TABLE "messages" ADD COLUMN "author_nickname" TEXT;
