CREATE TABLE "bootnode_pages" (
	"cursor_in" text PRIMARY KEY NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb NOT NULL,
	"cursor_out" text NOT NULL,
	"last_event_ledger" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ct_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account" text NOT NULL,
	"type" text NOT NULL,
	"counterparty" text NOT NULL,
	"amount" text,
	"ledger" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"event_id" text NOT NULL,
	"ciphertexts" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cursors" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"ledger" integer NOT NULL,
	"ledger_closed_at" timestamp with time zone NOT NULL,
	"tx_hash" text NOT NULL,
	"tx_index" integer NOT NULL,
	"op_index" integer NOT NULL,
	"event_index" integer NOT NULL,
	"topic" jsonb NOT NULL,
	"value_xdr" text NOT NULL,
	"in_successful_call" boolean NOT NULL
);
