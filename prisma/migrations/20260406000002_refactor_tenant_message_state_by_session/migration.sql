-- Drop the old composite unique constraint if it exists
ALTER TABLE "tenant_message_state" DROP CONSTRAINT IF EXISTS "tenant_message_state_session_id_from_account_to_account_key";

-- If multiple rows exist for the same session_id (one per from_account+to_account channel),
-- keep only the row with the highest last_forwarded_id so no events are re-forwarded.
DELETE FROM "tenant_message_state"
WHERE id NOT IN (
    SELECT DISTINCT ON (session_id) id
    FROM "tenant_message_state"
    ORDER BY session_id, last_forwarded_id DESC
);

-- Drop the now-redundant columns
ALTER TABLE "tenant_message_state" DROP COLUMN "from_account";
ALTER TABLE "tenant_message_state" DROP COLUMN "to_account";

-- Add the new per-session unique constraint
ALTER TABLE "tenant_message_state" ADD CONSTRAINT "tenant_message_state_session_id_key" UNIQUE ("session_id");
