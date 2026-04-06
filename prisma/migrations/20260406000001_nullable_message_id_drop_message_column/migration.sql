-- Drop columns superseded by raw_payload and session-level tracking
ALTER TABLE "messages" DROP COLUMN IF EXISTS "telegram_chat_id";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "telegram_message_id";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "from_account";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "to_account";

-- Drop the message text column — raw_payload carries the full event payload going forward
ALTER TABLE "messages" DROP COLUMN IF EXISTS "message";
