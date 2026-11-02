-- S3-style object keys: `PUT /api/v1/objects/<key>` addresses a file by path.
-- 700 characters, because MySQL's InnoDB index limit is 3072 bytes and a
-- utf8mb4 character can be 4 (700 * 4 = 2800, plus 144 for the CHAR(36) user id).
ALTER TABLE `files` ADD COLUMN `object_key` VARCHAR(700) NULL;

-- One row per key per user: the second PUT replaces the first object.
-- MySQL allows many NULLs in a unique index, so dashboard uploads are unaffected.
CREATE UNIQUE INDEX `files_user_id_object_key_key` ON `files`(`user_id`, `object_key`);
