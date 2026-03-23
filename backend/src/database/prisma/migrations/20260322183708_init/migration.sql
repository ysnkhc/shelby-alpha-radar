-- CreateTable
CREATE TABLE "blobs" (
    "id" SERIAL NOT NULL,
    "blob_id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "content_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blob_metadata" (
    "id" SERIAL NOT NULL,
    "blob_id" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "file_type" TEXT,

    CONSTRAINT "blob_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawler_state" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawler_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "blobs_blob_id_key" ON "blobs"("blob_id");

-- CreateIndex
CREATE INDEX "blobs_wallet_idx" ON "blobs"("wallet");

-- CreateIndex
CREATE INDEX "blobs_created_at_idx" ON "blobs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "blob_metadata_blob_id_key" ON "blob_metadata"("blob_id");

-- CreateIndex
CREATE UNIQUE INDEX "crawler_state_key_key" ON "crawler_state"("key");

-- AddForeignKey
ALTER TABLE "blob_metadata" ADD CONSTRAINT "blob_metadata_blob_id_fkey" FOREIGN KEY ("blob_id") REFERENCES "blobs"("blob_id") ON DELETE CASCADE ON UPDATE CASCADE;
