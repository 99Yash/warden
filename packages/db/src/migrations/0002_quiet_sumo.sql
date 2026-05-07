CREATE TABLE `file_state` (
	`file_path` text PRIMARY KEY NOT NULL,
	`current_sha` text NOT NULL,
	`observed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_graph` (
	`file_path` text NOT NULL,
	`file_sha` text NOT NULL,
	`imports_json` text NOT NULL,
	`exports_json` text NOT NULL,
	`computed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`file_path`, `file_sha`)
);
