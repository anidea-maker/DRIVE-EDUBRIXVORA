-- Website/object API hardening.
--
-- Additive and non-destructive: no existing row is rewritten. Changing the
-- column DEFAULT affects only future registrations; existing accounts keep
-- their stored role so current administrators and integrations keep working.
-- The new table is only written when API_RATE_LIMIT_STORAGE=database, which is
-- the shared/persistent limiter for multi-instance deployments.

ALTER TABLE `users`
  MODIFY COLUMN `role` VARCHAR(32) NOT NULL DEFAULT 'visitor';

CREATE TABLE `api_key_rate_limit_windows` (
  `id` CHAR(36) NOT NULL,
  `api_key_id` CHAR(36) NOT NULL,
  `window_start` DATETIME(3) NOT NULL,
  `count` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `api_key_rate_limit_windows_api_key_id_window_start_key`(`api_key_id`, `window_start`),
  INDEX `api_key_rate_limit_windows_window_start_idx`(`window_start`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `api_key_rate_limit_windows`
  ADD CONSTRAINT `api_key_rate_limit_windows_api_key_id_fkey`
  FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
