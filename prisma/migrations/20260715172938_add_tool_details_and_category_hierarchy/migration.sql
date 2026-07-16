/*
  Warnings:

  - A unique constraint covering the columns `[slug]` on the table `websites` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ToolTagKind" AS ENUM ('platform', 'pricing', 'topic');

-- CreateEnum
CREATE TYPE "ToolLinkKind" AS ENUM ('twitter', 'facebook', 'instagram', 'youtube', 'linkedin', 'tiktok', 'github', 'discord', 'reddit', 'pinterest', 'email', 'pricing', 'login', 'signup', 'about', 'contact', 'other');

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "parent_id" INTEGER;

-- AlterTable
ALTER TABLE "websites" ADD COLUMN     "slug" TEXT;

-- CreateTable
CREATE TABLE "tool_details" (
    "id" SERIAL NOT NULL,
    "website_id" INTEGER NOT NULL,
    "what" TEXT,
    "how" TEXT,
    "features_text" TEXT,
    "features" JSONB,
    "use_cases" JSONB,
    "rating" DOUBLE PRECISION,
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "saved_count" INTEGER NOT NULL DEFAULT 0,
    "monthly_visitors" INTEGER,
    "listed_at" TIMESTAMP(3),
    "source" TEXT,
    "external_raw" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_tags" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "ToolTagKind" NOT NULL,

    CONSTRAINT "tool_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_tool_tags" (
    "website_id" INTEGER NOT NULL,
    "tag_id" INTEGER NOT NULL,

    CONSTRAINT "website_tool_tags_pkey" PRIMARY KEY ("website_id","tag_id")
);

-- CreateTable
CREATE TABLE "tool_links" (
    "id" SERIAL NOT NULL,
    "website_id" INTEGER NOT NULL,
    "kind" "ToolLinkKind" NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_media" (
    "id" SERIAL NOT NULL,
    "website_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'screenshot',
    "url" TEXT NOT NULL,
    "alt" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_faqs" (
    "id" SERIAL NOT NULL,
    "website_id" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tool_faqs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tool_details_website_id_key" ON "tool_details"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "tool_tags_slug_key" ON "tool_tags"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tool_tags_kind_name_key" ON "tool_tags"("kind", "name");

-- CreateIndex
CREATE INDEX "website_tool_tags_tag_id_idx" ON "website_tool_tags"("tag_id");

-- CreateIndex
CREATE INDEX "tool_links_website_id_idx" ON "tool_links"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "tool_links_website_id_kind_url_key" ON "tool_links"("website_id", "kind", "url");

-- CreateIndex
CREATE INDEX "tool_media_website_id_idx" ON "tool_media"("website_id");

-- CreateIndex
CREATE INDEX "tool_faqs_website_id_idx" ON "tool_faqs"("website_id");

-- CreateIndex
CREATE INDEX "categories_parent_id_idx" ON "categories"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "websites_slug_key" ON "websites"("slug");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_details" ADD CONSTRAINT "tool_details_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_tool_tags" ADD CONSTRAINT "website_tool_tags_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_tool_tags" ADD CONSTRAINT "website_tool_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tool_tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_links" ADD CONSTRAINT "tool_links_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_media" ADD CONSTRAINT "tool_media_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_faqs" ADD CONSTRAINT "tool_faqs_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
