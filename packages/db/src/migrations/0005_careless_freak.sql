CREATE TABLE `file_chunks` (
	`file_path` text NOT NULL,
	`chunk_hash` text NOT NULL,
	`file_sha` text NOT NULL,
	`indexed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`file_path`, `chunk_hash`)
);
--> statement-breakpoint
CREATE INDEX `idx_fc_path` ON `file_chunks` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_fc_hash` ON `file_chunks` (`chunk_hash`);