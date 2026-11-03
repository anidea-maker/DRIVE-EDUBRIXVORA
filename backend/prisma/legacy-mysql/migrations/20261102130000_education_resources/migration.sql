-- Educational resource registry for Edvanta.
--
-- Additive only: no column is dropped, rewritten or backfilled with invented
-- data. Existing dashboard files keep their provider ids and behaviour; they
-- simply have is_resource = 0 and visibility = 'private' until an administrator
-- explicitly publishes them through the resource API.
-- The `files.id` UUID remains the stable application-level identifier. Google
-- Drive file ids and S3 object keys continue to live in `provider_file_id` and
-- are resolved through `connected_account_id` (bucket details live in
-- `s3_storage_configs`). They are deliberately NOT interchangeable.

ALTER TABLE `users`
  ADD COLUMN `role` VARCHAR(32) NOT NULL DEFAULT 'admin';

ALTER TABLE `files`
  ADD COLUMN `is_resource` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `title` VARCHAR(255) NULL,
  ADD COLUMN `description` TEXT NULL,
  ADD COLUMN `category` VARCHAR(191) NULL,
  ADD COLUMN `subject` VARCHAR(191) NULL,
  ADD COLUMN `academic_level` VARCHAR(191) NULL,
  ADD COLUMN `exam_type` VARCHAR(191) NULL,
  ADD COLUMN `visibility` VARCHAR(32) NOT NULL DEFAULT 'private',
  ADD COLUMN `client_request_id` VARCHAR(191) NULL,
  ADD COLUMN `resource_metadata` JSON NULL,
  ADD COLUMN `uploaded_by` CHAR(36) NULL,
  ADD COLUMN `last_modified_by` CHAR(36) NULL,
  ADD COLUMN `availability` VARCHAR(32) NOT NULL DEFAULT 'unknown',
  ADD COLUMN `last_verified_at` DATETIME(3) NULL;

-- One metadata record per retry-safe upload request, per owner. MySQL permits
-- multiple NULLs in a unique index, so ordinary dashboard uploads are unaffected.
CREATE UNIQUE INDEX `files_user_id_client_request_id_key`
  ON `files`(`user_id`, `client_request_id`);

CREATE INDEX `files_user_id_is_resource_status_created_at_idx`
  ON `files`(`user_id`, `is_resource`, `status`, `created_at`);
CREATE INDEX `files_user_id_category_idx` ON `files`(`user_id`, `category`);
CREATE INDEX `files_user_id_subject_idx` ON `files`(`user_id`, `subject`);
CREATE INDEX `files_user_id_academic_level_idx` ON `files`(`user_id`, `academic_level`);
CREATE INDEX `files_user_id_exam_type_idx` ON `files`(`user_id`, `exam_type`);
