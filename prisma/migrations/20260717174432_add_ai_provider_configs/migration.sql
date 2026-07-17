-- CreateTable
CREATE TABLE "ai_provider_configs" (
    "id" SERIAL NOT NULL,
    "provider_key" TEXT NOT NULL,
    "display_name" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "base_url" TEXT,
    "encrypted_api_key" TEXT,
    "api_key_last4" TEXT,
    "api_key_source" TEXT,
    "default_model" TEXT,
    "model_presets" JSONB,
    "supports_batch" BOOLEAN NOT NULL DEFAULT false,
    "supports_direct" BOOLEAN NOT NULL DEFAULT true,
    "supports_json_schema" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "last_tested_at" TIMESTAMP(3),
    "last_test_status" TEXT,
    "last_test_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_provider_configs_provider_key_key" ON "ai_provider_configs"("provider_key");
