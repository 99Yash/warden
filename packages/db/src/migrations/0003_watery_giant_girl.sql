CREATE TABLE `chunks` (
	`chunk_hash` text PRIMARY KEY NOT NULL,
	`file_path` text NOT NULL,
	`file_sha` text NOT NULL,
	`language` text NOT NULL,
	`symbol_path_json` text NOT NULL,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `embeddings` (
	`chunk_hash` text NOT NULL,
	`model_id` text NOT NULL,
	`model_version` text NOT NULL,
	`vector` blob NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`chunk_hash`, `model_id`, `model_version`)
);
--> statement-breakpoint
CREATE TABLE `index_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`task_id` text PRIMARY KEY NOT NULL,
	`task_kind` text NOT NULL,
	`inputs_json` text NOT NULL,
	`status` text NOT NULL,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `merkle` (
	`node_path` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`kind` text NOT NULL,
	`observed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
