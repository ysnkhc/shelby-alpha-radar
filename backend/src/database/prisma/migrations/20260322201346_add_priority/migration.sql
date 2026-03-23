-- AlterTable
ALTER TABLE "alpha_events" ADD COLUMN     "priority" TEXT NOT NULL DEFAULT 'LOW';

-- CreateIndex
CREATE INDEX "alpha_events_priority_idx" ON "alpha_events"("priority");
