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
  `role` ENUM('admin','hr','manager','salesperson') NOT NULL DEFAULT 'salesperson',
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
  `requested_role` ENUM('admin','hr','manager','salesperson') NOT NULL,
  `approved_role` ENUM('admin','hr','manager','salesperson') NULL,
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
  `role` ENUM('admin','hr','manager','salesperson') NOT NULL,
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

CREATE TABLE IF NOT EXISTS `lff_teams` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `name` VARCHAR(191) NOT NULL,
  `manager_id` VARCHAR(64) NULL,
  `manager_name` VARCHAR(191) NULL,
  `member_ids_json` LONGTEXT NOT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_teams_company` (`company_id`)
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

CREATE TABLE IF NOT EXISTS `lff_location_logs` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `user_id` VARCHAR(64) NOT NULL,
  `latitude` DECIMAL(10,7) NOT NULL,
  `longitude` DECIMAL(10,7) NOT NULL,
  `accuracy` DECIMAL(10,2) NULL,
  `speed` DECIMAL(10,2) NULL,
  `heading` DECIMAL(10,2) NULL,
  `battery_level` DECIMAL(6,2) NULL,
  `geofence_id` VARCHAR(64) NULL,
  `geofence_name` VARCHAR(191) NULL,
  `is_inside_geofence` TINYINT(1) NOT NULL DEFAULT 0,
  `captured_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_location_user_time` (`user_id`, `captured_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_salaries` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `employee_id` VARCHAR(64) NOT NULL,
  `employee_name` VARCHAR(191) NOT NULL,
  `employee_email` VARCHAR(191) NULL,
  `label` VARCHAR(191) NULL,
  `period_start` DATE NULL,
  `period_end` DATE NULL,
  `payment_date` DATE NULL,
  `payment_mode` VARCHAR(64) NULL,
  `bank_account` VARCHAR(191) NULL,
  `note` LONGTEXT NULL,
  `month` VARCHAR(32) NOT NULL,
  `basic` DECIMAL(12,2) NOT NULL,
  `hra` DECIMAL(12,2) NOT NULL,
  `transport` DECIMAL(12,2) NOT NULL,
  `medical` DECIMAL(12,2) NOT NULL,
  `bonus` DECIMAL(12,2) NOT NULL,
  `overtime` DECIMAL(12,2) NOT NULL,
  `tax` DECIMAL(12,2) NOT NULL,
  `pf` DECIMAL(12,2) NOT NULL,
  `insurance` DECIMAL(12,2) NOT NULL,
  `gross_pay` DECIMAL(12,2) NOT NULL,
  `total_deductions` DECIMAL(12,2) NOT NULL,
  `net_pay` DECIMAL(12,2) NOT NULL,
  `status` ENUM('pending','approved','paid') NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_salaries_employee_month` (`employee_id`, `month`),
  KEY `idx_lff_salaries_company` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_bank_accounts` (
  `id` VARCHAR(64) NOT NULL,
  `employee_id` VARCHAR(64) NULL,
  `employee_name` VARCHAR(191) NOT NULL,
  `employee_email` VARCHAR(191) NOT NULL,
  `account_type` ENUM('bank','upi') NOT NULL DEFAULT 'bank',
  `dolibarr_ref` VARCHAR(32) NULL,
  `dolibarr_label` VARCHAR(191) NULL,
  `dolibarr_type` ENUM('savings','current','cash') NOT NULL DEFAULT 'current',
  `currency_code` VARCHAR(3) NOT NULL DEFAULT 'INR',
  `country_code` VARCHAR(8) NOT NULL DEFAULT 'IN',
  `country_id` INT NOT NULL DEFAULT 117,
  `status` ENUM('open','closed') NOT NULL DEFAULT 'open',
  `bank_name` VARCHAR(191) NULL,
  `bank_address` LONGTEXT NULL,
  `account_number` VARCHAR(64) NULL,
  `ifsc_code` VARCHAR(16) NULL,
  `upi_id` VARCHAR(191) NULL,
  `holder_name` VARCHAR(191) NULL,
  `website` VARCHAR(255) NULL,
  `comment` LONGTEXT NULL,
  `is_default` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_bank_accounts_email` (`employee_email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_tasks` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `title` VARCHAR(191) NOT NULL,
  `description` LONGTEXT NOT NULL,
  `task_type` VARCHAR(32) NULL,
  `assigned_to_id` VARCHAR(64) NOT NULL,
  `assigned_to_name` VARCHAR(191) NOT NULL,
  `assigned_by_id` VARCHAR(64) NOT NULL,
  `assigned_by_name` VARCHAR(191) NOT NULL,
  `status` ENUM('pending','in_progress','completed') NOT NULL,
  `priority` ENUM('low','medium','high') NOT NULL,
  `due_date` DATETIME NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  `visit_plan_date` DATETIME NULL,
  `visit_sequence` INT NULL,
  `visit_location_label` VARCHAR(191) NULL,
  `visit_location_address` LONGTEXT NULL,
  `arrival_at` DATETIME NULL,
  `departure_at` DATETIME NULL,
  `meeting_notes` LONGTEXT NULL,
  `meeting_notes_updated_at` DATETIME NULL,
  `visit_departure_notes` LONGTEXT NULL,
  `visit_departure_notes_updated_at` DATETIME NULL,
  `auto_capture_conversation_id` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_tasks_assigned_to` (`assigned_to_id`),
  KEY `idx_lff_tasks_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_expenses` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `user_id` VARCHAR(64) NOT NULL,
  `user_name` VARCHAR(191) NOT NULL,
  `category` VARCHAR(80) NOT NULL,
  `amount` DECIMAL(12,2) NOT NULL,
  `description` LONGTEXT NOT NULL,
  `status` ENUM('pending','approved','rejected') NOT NULL,
  `date` DATE NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_expenses_user_date` (`user_id`, `date`),
  KEY `idx_lff_expenses_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_conversations` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `title` VARCHAR(191) NOT NULL,
  `customer_name` VARCHAR(191) NOT NULL,
  `salesperson_id` VARCHAR(64) NOT NULL,
  `salesperson_name` VARCHAR(191) NOT NULL,
  `audio_url` LONGTEXT NULL,
  `transcript` LONGTEXT NOT NULL,
  `summary` LONGTEXT NULL,
  `sentiment` VARCHAR(32) NULL,
  `score` DECIMAL(6,2) NULL,
  `action_items_json` LONGTEXT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_conversations_salesperson` (`salesperson_id`),
  KEY `idx_lff_conversations_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_audit_logs` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `user_id` VARCHAR(64) NOT NULL,
  `user_name` VARCHAR(191) NOT NULL,
  `action` VARCHAR(191) NOT NULL,
  `details` LONGTEXT NOT NULL,
  `module` VARCHAR(120) NULL,
  `timestamp` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_audit_company_time` (`company_id`, `timestamp`),
  KEY `idx_lff_audit_user_time` (`user_id`, `timestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_notifications` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `title` VARCHAR(191) NOT NULL,
  `body` LONGTEXT NOT NULL,
  `kind` VARCHAR(64) NOT NULL,
  `audience` VARCHAR(32) NOT NULL,
  `created_by_id` VARCHAR(64) NOT NULL,
  `created_by_name` VARCHAR(191) NOT NULL,
  `created_at` DATETIME NOT NULL,
  `read_by_user_ids_json` LONGTEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_notifications_company_time` (`company_id`, `created_at`),
  KEY `idx_lff_notifications_kind` (`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_support_threads` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `subject` VARCHAR(191) NOT NULL,
  `category` VARCHAR(80) NOT NULL,
  `priority` ENUM('low','medium','high') NOT NULL,
  `status` ENUM('open','in_progress','closed') NOT NULL DEFAULT 'open',
  `requested_by_id` VARCHAR(64) NOT NULL,
  `requested_by_name` VARCHAR(191) NOT NULL,
  `requested_by_role` ENUM('admin','hr','manager','salesperson') NOT NULL,
  `assigned_to_id` VARCHAR(64) NULL,
  `assigned_to_name` VARCHAR(191) NULL,
  `assigned_to_role` ENUM('admin','hr','manager','salesperson') NULL,
  `last_message` LONGTEXT NULL,
  `last_message_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_support_threads_status` (`status`),
  KEY `idx_lff_support_threads_company` (`company_id`),
  KEY `idx_lff_support_threads_requested_by` (`requested_by_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_support_messages` (
  `id` VARCHAR(64) NOT NULL,
  `thread_id` VARCHAR(64) NOT NULL,
  `sender_id` VARCHAR(64) NOT NULL,
  `sender_name` VARCHAR(191) NOT NULL,
  `sender_role` ENUM('admin','hr','manager','salesperson') NOT NULL,
  `body` LONGTEXT NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_support_messages_thread_time` (`thread_id`, `created_at`)
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

CREATE TABLE IF NOT EXISTS `lff_company_settings` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `company_id` VARCHAR(64) NOT NULL,
  `setting_key` VARCHAR(120) NOT NULL,
  `setting_value` LONGTEXT NOT NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_lff_company_settings` (`company_id`, `setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_app_state` (
  `state_key` VARCHAR(191) NOT NULL,
  `json_value` LONGTEXT NOT NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`state_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_stockists` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `name` VARCHAR(191) NOT NULL,
  `phone` VARCHAR(40) NULL,
  `location` VARCHAR(191) NULL,
  `pincode` VARCHAR(20) NULL,
  `notes` LONGTEXT NULL,
  `assigned_salesperson_ids_json` LONGTEXT NULL,
  `stock_in` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `stock_out` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `stock_balance` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `last_stock_update` DATETIME NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_stockists_company` (`company_id`),
  KEY `idx_lff_stockists_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_stock_transfers` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `stockist_id` VARCHAR(64) NOT NULL,
  `stockist_name` VARCHAR(191) NOT NULL,
  `transfer_type` ENUM('in','out') NOT NULL DEFAULT 'in',
  `item_name` VARCHAR(191) NOT NULL,
  `item_id` VARCHAR(64) NULL,
  `quantity` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `unit_label` VARCHAR(40) NULL,
  `salesperson_id` VARCHAR(64) NULL,
  `salesperson_name` VARCHAR(191) NULL,
  `note` LONGTEXT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_stock_transfers_company` (`company_id`),
  KEY `idx_lff_stock_transfers_stockist` (`stockist_id`),
  KEY `idx_lff_stock_transfers_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_incentive_goal_plans` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `title` VARCHAR(191) NOT NULL,
  `period` ENUM('daily','weekly','monthly') NOT NULL DEFAULT 'monthly',
  `target_qty` INT NOT NULL DEFAULT 0,
  `threshold_percent` DECIMAL(5,2) NOT NULL DEFAULT 0,
  `per_unit_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_incentive_goal_company` (`company_id`),
  KEY `idx_lff_incentive_goal_period` (`period`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_incentive_product_plans` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `product_id` VARCHAR(64) NULL,
  `product_name` VARCHAR(191) NOT NULL,
  `per_unit_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_incentive_product_company` (`company_id`),
  KEY `idx_lff_incentive_product_product` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lff_incentive_payouts` (
  `id` VARCHAR(64) NOT NULL,
  `company_id` VARCHAR(64) NULL,
  `salesperson_id` VARCHAR(64) NOT NULL,
  `salesperson_name` VARCHAR(191) NOT NULL,
  `range_key` ENUM('daily','weekly','monthly') NOT NULL DEFAULT 'monthly',
  `range_start` DATE NOT NULL,
  `range_end` DATE NOT NULL,
  `goal_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `product_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `total_amount` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `status` ENUM('pending','paid') NOT NULL DEFAULT 'pending',
  `note` LONGTEXT NULL,
  `created_at` DATETIME NOT NULL,
  `created_by_id` VARCHAR(64) NULL,
  `created_by_name` VARCHAR(191) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lff_incentive_payout_company` (`company_id`),
  KEY `idx_lff_incentive_payout_salesperson` (`salesperson_id`),
  KEY `idx_lff_incentive_payout_range` (`range_key`, `range_start`, `range_end`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
