-- Lumina FieldForce app schema (safe with existing Dolibarr tables)
-- Target DB (as shared by you): i9942982_oc9i1
-- Import this file in phpMyAdmin SQL tab.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- Optional:
-- USE `i9942982_oc9i1`;

CREATE TABLE IF NOT EXISTS `lff_companies` (
  `id` VARCHAR(64) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `legal_name` VARCHAR(191) NOT NULL,
  `industry` VARCHAR(120) NOT NULL,
  `headquarters` VARCHAR(191) NOT NULL,
  `primary_branch` VARCHAR(120) NOT NULL,
  `support_email` VARCHAR(191) NOT NULL,
  `support_phone` VARCHAR(40) NOT NULL,
  `attendance_zone_label` VARCHAR(120) NOT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_companies_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_users` (
  `id` VARCHAR(64) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` ENUM('admin','hr','manager','salesperson','employee') NOT NULL DEFAULT 'salesperson',
  `company_id` VARCHAR(64) NOT NULL,
  `company_name` VARCHAR(191) NOT NULL,
  `company_ids_json` LONGTEXT NULL,
  `department` VARCHAR(120) NOT NULL,
  `branch` VARCHAR(120) NOT NULL,
  `phone` VARCHAR(40) NOT NULL,
  `join_date` DATE NOT NULL,
  `avatar` LONGTEXT NULL,
  `manager_id` VARCHAR(64) NULL,
  `manager_name` VARCHAR(191) NULL,
  `approval_status` ENUM('pending','approved','rejected') NOT NULL DEFAULT 'approved',
  `requested_company_name` VARCHAR(191) NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_lff_users_email` (`email`),
  KEY `idx_lff_users_company` (`company_id`),
  KEY `idx_lff_users_role` (`role`),
  CONSTRAINT `fk_lff_users_company` FOREIGN KEY (`company_id`) REFERENCES `lff_companies` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_access_requests` (
  `id` VARCHAR(64) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `password_hash` VARCHAR(255) NULL,
  `requested_role` ENUM('admin','hr','manager','salesperson','employee') NOT NULL,
  `approved_role` ENUM('admin','hr','manager','salesperson','employee') NULL,
  `requested_department` VARCHAR(120) NOT NULL,
  `requested_branch` VARCHAR(120) NOT NULL,
  `requested_company_name` VARCHAR(191) NULL,
  `status` ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `requested_at` DATETIME NOT NULL,
  `reviewed_at` DATETIME NULL,
  `reviewed_by_id` VARCHAR(64) NULL,
  `reviewed_by_name` VARCHAR(191) NULL,
  `review_comment` LONGTEXT NULL,
  `assigned_company_ids_json` LONGTEXT NULL,
  `assigned_manager_id` VARCHAR(64) NULL,
  `assigned_manager_name` VARCHAR(191) NULL,
  `assigned_stockist_id` VARCHAR(64) NULL,
  `assigned_stockist_name` VARCHAR(191) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_access_status` (`status`),
  KEY `idx_lff_access_email` (`email`),
  KEY `idx_lff_access_requested_at` (`requested_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_employees` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `role` ENUM('admin','hr','manager','salesperson','employee') NOT NULL,
  `department` VARCHAR(120) NOT NULL,
  `status` ENUM('active','idle','offline') NOT NULL DEFAULT 'active',
  `email` VARCHAR(191) NOT NULL,
  `phone` VARCHAR(40) NOT NULL,
  `branch` VARCHAR(120) NOT NULL,
  `join_date` DATE NOT NULL,
  `avatar` LONGTEXT NULL,
  `manager_id` VARCHAR(64) NULL,
  `manager_name` VARCHAR(191) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_employees_company` (`company_id`),
  KEY `idx_lff_employees_role` (`role`),
  KEY `idx_lff_employees_email` (`email`),
  CONSTRAINT `fk_lff_employees_company` FOREIGN KEY (`company_id`) REFERENCES `lff_companies` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;



CREATE TABLE IF NOT EXISTS `lff_geofences` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `name` VARCHAR(191) NOT NULL,
  `latitude` DECIMAL(10,7) NOT NULL,
  `longitude` DECIMAL(10,7) NOT NULL,
  `radius_meters` INT NOT NULL,
  `assigned_employee_ids_json` LONGTEXT NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `allow_override` TINYINT(1) NOT NULL DEFAULT 0,
  `working_hours_start` VARCHAR(8) NULL,
  `working_hours_end` VARCHAR(8) NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_geofences_company` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_attendance` (
  `id` VARCHAR(64) NOT NULL,
  `user_id` VARCHAR(64) NOT NULL,
  `user_name` VARCHAR(191) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `type` ENUM('checkin','checkout') NOT NULL,
  `timestamp` DATETIME NOT NULL,
  `timestamp_server` DATETIME NULL,
  `lat` DECIMAL(10,7) NULL,
  `lng` DECIMAL(10,7) NULL,
  `geofence_id` VARCHAR(64) NULL,
  `geofence_name` VARCHAR(191) NULL,
  `photo_url` LONGTEXT NULL,
  `device_id` VARCHAR(128) NULL,
  `is_inside_geofence` TINYINT(1) NULL,
  `source` ENUM('mobile','manual','synced') NULL,
  `notes` LONGTEXT NULL,
  `photo` LONGTEXT NULL,
  `approval_status` ENUM('pending','approved','rejected') NULL,
  `approval_reviewed_by_id` VARCHAR(64) NULL,
  `approval_reviewed_by_name` VARCHAR(191) NULL,
  `approval_reviewed_at` DATETIME NULL,
  `approval_comment` LONGTEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_attendance_user_time` (`user_id`, `timestamp`),
  KEY `idx_lff_attendance_company` (`company_id`),
  KEY `idx_lff_attendance_approval` (`approval_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_attendance_anomalies` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `user_id` VARCHAR(64) NOT NULL,
  `attendance_id` VARCHAR(64) NULL,
  `type` VARCHAR(64) NOT NULL,
  `severity` ENUM('low','medium','high') NOT NULL,
  `details` LONGTEXT NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_anomalies_user_time` (`user_id`, `created_at`),
  KEY `idx_lff_anomalies_type` (`type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_dolibarr_sync_logs` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `user_id` VARCHAR(64) NOT NULL,
  `user_name` VARCHAR(191) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `status` ENUM('created','exists','skipped','failed') NOT NULL,
  `message` LONGTEXT NOT NULL,
  `dolibarr_user_id` BIGINT NULL,
  `endpoint_used` LONGTEXT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_dolibarr_logs_user_time` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_app_state` (
  `state_key` VARCHAR(191) NOT NULL,
  `json_value` LONGTEXT NOT NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`state_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
