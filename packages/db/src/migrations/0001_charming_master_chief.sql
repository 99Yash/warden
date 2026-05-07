CREATE TABLE `llm_review_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_key` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`payload` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `llm_review_cache_cache_key_unique` ON `llm_review_cache` (`cache_key`);--> statement-breakpoint
CREATE INDEX `llm_review_cache_provider_idx` ON `llm_review_cache` (`provider`);