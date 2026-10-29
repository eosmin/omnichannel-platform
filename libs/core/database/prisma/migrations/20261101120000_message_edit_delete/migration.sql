-- AlterTable
ALTER TABLE "messages" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "edited_at" TIMESTAMP(3),
ADD COLUMN "edited_by_type" TEXT,
ADD COLUMN "edited_by_id" TEXT,
ADD COLUMN "pending_content" TEXT,
ADD COLUMN "edit_status" TEXT,
ADD COLUMN "edit_error" TEXT,
ADD COLUMN "deleted_at" TIMESTAMP(3),
ADD COLUMN "deleted_by_type" TEXT,
ADD COLUMN "deleted_by_id" TEXT,
ADD COLUMN "delete_status" TEXT,
ADD COLUMN "delete_error" TEXT,
ADD COLUMN "change_requested_at" TIMESTAMP(3),
ADD COLUMN "content_purged_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "message_revisions" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT,
    "edited_by_type" TEXT NOT NULL,
    "edited_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "messages_deleted_at_idx" ON "messages"("deleted_at");

-- The sweep of the edits and deletions that waited too long reads only the rows that still wait
CREATE INDEX "messages_change_requested_at_idx" ON "messages"("change_requested_at") WHERE "change_requested_at" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "message_revisions_message_id_version_key" ON "message_revisions"("message_id", "version");

-- CreateIndex
CREATE INDEX "message_revisions_store_id_idx" ON "message_revisions"("store_id");

-- AddForeignKey
ALTER TABLE "message_revisions" ADD CONSTRAINT "message_revisions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_revisions" ADD CONSTRAINT "message_revisions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The Admin role holds every permission: the stores that exist get the new one, as the ones made
-- from now on do (RolePresets)
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, 'messages:view_deleted', r."id"
FROM "roles" r
WHERE r."is_system" AND r."name" = 'Admin'
ON CONFLICT ("role_id", "name") DO NOTHING;
