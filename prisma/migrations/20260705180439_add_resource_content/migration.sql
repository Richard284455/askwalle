-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('news', 'review', 'prompt', 'skill', 'tutorial');

-- CreateEnum
CREATE TYPE "ResourceStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "ResourceSourceType" AS ENUM ('original', 'source_informed', 'external');

-- CreateTable
CREATE TABLE "resource_contents" (
    "id" SERIAL NOT NULL,
    "type" "ResourceType" NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "tags" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "ResourceStatus" NOT NULL DEFAULT 'draft',
    "sourceType" "ResourceSourceType" NOT NULL DEFAULT 'original',
    "sources" JSONB,
    "content" JSONB NOT NULL,
    "seoTitle" TEXT,
    "seoDescription" TEXT,

    CONSTRAINT "resource_contents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resource_contents_type_status_publishedAt_idx" ON "resource_contents"("type", "status", "publishedAt");

-- CreateIndex
CREATE INDEX "resource_contents_category_idx" ON "resource_contents"("category");

-- CreateIndex
CREATE UNIQUE INDEX "resource_contents_type_slug_key" ON "resource_contents"("type", "slug");
