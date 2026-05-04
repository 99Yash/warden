CREATE TABLE `external_knowledge` (
	`id` text PRIMARY KEY NOT NULL,
	`query_key` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text,
	`payload` text NOT NULL,
	`ttl_expires_at` integer NOT NULL,
	`retrieved_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_knowledge_query_key_unique` ON `external_knowledge` (`query_key`);--> statement-breakpoint
CREATE INDEX `external_knowledge_source_type_idx` ON `external_knowledge` (`source_type`);--> statement-breakpoint
CREATE INDEX `external_knowledge_ttl_expires_at_idx` ON `external_knowledge` (`ttl_expires_at`);