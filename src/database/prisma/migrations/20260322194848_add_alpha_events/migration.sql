-- CreateTable
CREATE TABLE "alpha_events" (
    "id" SERIAL NOT NULL,
    "owner" TEXT NOT NULL,
    "blob_name" TEXT,
    "signal_type" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "explanation" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alpha_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alpha_events_owner_idx" ON "alpha_events"("owner");

-- CreateIndex
CREATE INDEX "alpha_events_score_idx" ON "alpha_events"("score");

-- CreateIndex
CREATE INDEX "alpha_events_created_at_idx" ON "alpha_events"("created_at");
