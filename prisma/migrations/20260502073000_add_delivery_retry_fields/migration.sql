-- Add delivery_failed value to MessageStatus enum
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'delivery_failed';

-- Add delivery retry tracking columns to messages
ALTER TABLE "messages"
    ADD COLUMN "delivery_retry_count"     INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "next_delivery_attempt_at" TIMESTAMP(3),
    ADD COLUMN "delivery_failed_at"       TIMESTAMP(3),
    ADD COLUMN "last_delivery_error"      TEXT;
