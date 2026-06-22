CREATE TABLE `review_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`input_hash` text NOT NULL,
	`mode` text NOT NULL,
	`model_boss` text NOT NULL,
	`model_worker_strong` text NOT NULL,
	`model_worker_cheap` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`comments_emitted` integer NOT NULL
);
