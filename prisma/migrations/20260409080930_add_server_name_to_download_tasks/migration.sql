-- AlterTable: add server routing columns to download_tasks
ALTER TABLE "download_tasks" ADD COLUMN "owner_session_id" BIGINT,
ADD COLUMN "server_name" VARCHAR(255);

-- CreateIndex
CREATE INDEX "download_tasks_server_name_status_created_at_idx" ON "download_tasks"("server_name", "status", "created_at");
