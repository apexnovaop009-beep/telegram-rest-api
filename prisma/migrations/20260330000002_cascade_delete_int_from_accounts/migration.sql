-- Change messages FK to cascade: deleting a TelegramSession now automatically
-- deletes its messages and attachments (attachments already cascade from messages).
ALTER TABLE "messages"
    DROP CONSTRAINT "messages_session_id_fkey",
    ADD CONSTRAINT "messages_session_id_fkey"
        FOREIGN KEY ("session_id") REFERENCES "telegram_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Change tenant_message_state FK to cascade as well.
ALTER TABLE "tenant_message_state"
    DROP CONSTRAINT "tenant_message_state_session_id_fkey",
    ADD CONSTRAINT "tenant_message_state_session_id_fkey"
        FOREIGN KEY ("session_id") REFERENCES "telegram_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Change from_accounts column from TEXT[] to INTEGER[] so it stores the
-- telegram_sessions.id integer instead of the long GramJS session string.
-- Existing rows are cleared because the old string values cannot be cast.
ALTER TABLE "download_tasks"
    ALTER COLUMN "from_accounts" TYPE INTEGER[]
        USING ARRAY[]::INTEGER[];
