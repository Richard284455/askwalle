-- CreateEnum
CREATE TYPE "RewriteStatus" AS ENUM ('raw_imported', 'draft_generated', 'human_reviewed');

-- AlterTable
ALTER TABLE "tool_details" ADD COLUMN     "ai_rewrite_draft" JSONB,
ADD COLUMN     "raw_imported_content" JSONB,
ADD COLUMN     "review_notes" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "rewrite_status" "RewriteStatus";
