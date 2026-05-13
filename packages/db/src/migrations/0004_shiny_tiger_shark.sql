CREATE TABLE `type_def_cache` (
	`package` text NOT NULL,
	`version` text NOT NULL,
	`symbol` text NOT NULL,
	`found` integer NOT NULL,
	`kind` text,
	`signature` text,
	`jsdoc` text,
	`dts_file` text,
	`line_start` integer,
	`line_end` integer,
	`reason` text,
	`retrieved_at` text NOT NULL,
	PRIMARY KEY(`package`, `version`, `symbol`)
);
