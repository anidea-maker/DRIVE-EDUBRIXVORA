-- CreateTable
CREATE TABLE "coming_soon_features" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'General',
    "icon" TEXT NOT NULL DEFAULT 'Sparkles',
    "status" TEXT NOT NULL DEFAULT 'coming_soon',
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "target_release" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "feature_votes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "feature_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feature_votes_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "coming_soon_features" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "feature_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "points_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "activity" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "points" INTEGER NOT NULL DEFAULT 10,
    "bonus_points" INTEGER NOT NULL DEFAULT 0,
    "bonus_threshold" INTEGER NOT NULL DEFAULT 0,
    "daily_cap" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "points_ledger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "activity" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "rule_points" INTEGER NOT NULL DEFAULT 0,
    "bonus_points" INTEGER NOT NULL DEFAULT 0,
    "file_id" TEXT,
    "note" TEXT,
    "reference" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "points_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "songs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "album" TEXT,
    "duration_seconds" INTEGER NOT NULL DEFAULT 0,
    "genre" TEXT NOT NULL DEFAULT 'study',
    "artwork_url" TEXT,
    "collection" TEXT NOT NULL DEFAULT 'Featured',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "coming_soon_features_key_key" ON "coming_soon_features"("key");

-- CreateIndex
CREATE INDEX "coming_soon_features_status_sort_order_idx" ON "coming_soon_features"("status", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "feature_votes_feature_id_user_id_key" ON "feature_votes"("feature_id", "user_id");

-- CreateIndex
CREATE INDEX "feature_votes_user_id_idx" ON "feature_votes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "points_rules_activity_key" ON "points_rules"("activity");

-- CreateIndex
CREATE UNIQUE INDEX "points_ledger_reference_key" ON "points_ledger"("reference");

-- CreateIndex
CREATE INDEX "points_ledger_user_id_created_at_idx" ON "points_ledger"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "points_ledger_user_id_activity_created_at_idx" ON "points_ledger"("user_id", "activity", "created_at");

-- CreateIndex
CREATE INDEX "songs_enabled_sort_order_idx" ON "songs"("enabled", "sort_order");
