CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"storage_usage_bytes" integer DEFAULT 0 NOT NULL,
	"storage_purchased_bytes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "book_configs" (
	"user_id" text NOT NULL,
	"book_hash" text NOT NULL,
	"meta_hash" text,
	"location" text,
	"xpointer" text,
	"progress" jsonb,
	"rsvp_position" text,
	"search_config" jsonb,
	"view_settings" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone,
	CONSTRAINT "book_configs_user_id_book_hash_pk" PRIMARY KEY("user_id","book_hash")
);
--> statement-breakpoint
CREATE TABLE "book_notes" (
	"user_id" text NOT NULL,
	"book_hash" text NOT NULL,
	"meta_hash" text,
	"id" text NOT NULL,
	"type" text,
	"cfi" text,
	"xpointer0" text,
	"xpointer1" text,
	"text" text,
	"style" text,
	"color" text,
	"note" text,
	"page" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone,
	CONSTRAINT "book_notes_user_id_book_hash_id_pk" PRIMARY KEY("user_id","book_hash","id")
);
--> statement-breakpoint
CREATE TABLE "books" (
	"user_id" text NOT NULL,
	"book_hash" text NOT NULL,
	"meta_hash" text,
	"format" text,
	"title" text,
	"source_title" text,
	"author" text,
	"group" text,
	"tags" text[],
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone,
	"uploaded_at" timestamp with time zone,
	"progress" integer[],
	"reading_status" text,
	"group_id" text,
	"group_name" text,
	"metadata" json,
	CONSTRAINT "books_user_id_book_hash_pk" PRIMARY KEY("user_id","book_hash")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"book_hash" text,
	"file_key" text NOT NULL,
	"file_size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone,
	"replica_kind" text,
	"replica_id" text,
	CONSTRAINT "files_file_key_unique" UNIQUE("file_key")
);
--> statement-breakpoint
CREATE TABLE "book_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"book_hash" text NOT NULL,
	"book_title" text NOT NULL,
	"book_author" text,
	"book_format" text NOT NULL,
	"book_size" bigint NOT NULL,
	"cfi" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"download_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_shares_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "replica_keys" (
	"user_id" text NOT NULL,
	"salt_id" text NOT NULL,
	"alg" text NOT NULL,
	"salt" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replica_keys_user_id_salt_id_pk" PRIMARY KEY("user_id","salt_id")
);
--> statement-breakpoint
CREATE TABLE "replicas" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"replica_id" text NOT NULL,
	"fields_jsonb" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"manifest_jsonb" jsonb,
	"deleted_at_ts" text,
	"reincarnation" text,
	"updated_at_ts" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replicas_user_id_kind_replica_id_pk" PRIMARY KEY("user_id","kind","replica_id"),
	CONSTRAINT "replicas_kind_allowlist" CHECK ("replicas"."kind" IN ('dictionary', 'font', 'texture', 'opds_catalog', 'settings')),
	CONSTRAINT "replicas_fields_size" CHECK (pg_column_size("replicas"."fields_jsonb") <= 65536),
	CONSTRAINT "replicas_schema_version" CHECK ("replicas"."schema_version" >= 1 AND "replicas"."schema_version" <= 1000)
);
--> statement-breakpoint
CREATE TABLE "apple_iap_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"platform" text,
	"product_id" text,
	"transaction_id" text,
	"original_transaction_id" text,
	"status" text,
	"purchase_date" timestamp with time zone,
	"expires_date" timestamp with time zone,
	"environment" text,
	"bundle_id" text,
	"quantity" integer DEFAULT 1,
	"auto_renew_status" boolean,
	"web_order_line_item_id" text,
	"subscription_group_identifier" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "apple_iap_subscriptions_user_id_original_transaction_id" UNIQUE("user_id","original_transaction_id")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"user_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "customers_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "customers_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
CREATE TABLE "google_iap_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"platform" text,
	"product_id" text,
	"purchase_token" text,
	"order_id" text,
	"status" text,
	"purchase_date" timestamp with time zone,
	"expires_date" timestamp with time zone,
	"environment" text,
	"package_name" text,
	"quantity" integer DEFAULT 1,
	"auto_renew_status" boolean,
	"purchase_state" integer,
	"acknowledgement_state" integer,
	"price_amount_micros" text,
	"price_currency_code" text,
	"country_code" text,
	"developer_payload" text,
	"linked_purchase_token" text,
	"obfuscated_external_account_id" text,
	"obfuscated_external_profile_id" text,
	"cancel_reason" integer,
	"user_cancellation_time_millis" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "google_iap_subscriptions_user_id_order_id" UNIQUE("user_id","order_id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"amount" integer,
	"currency" text,
	"status" text NOT NULL,
	"payment_method" text,
	"product_id" text,
	"storage_gb" integer DEFAULT 0,
	"metadata" jsonb,
	"stripe_customer_id" text,
	"stripe_checkout_id" text,
	"stripe_payment_intent_id" text,
	"apple_transaction_id" text,
	"apple_original_transaction_id" text,
	"google_order_id" text,
	"google_purchase_token" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "payments_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id"),
	CONSTRAINT "payments_apple_original_transaction_id_unique" UNIQUE("apple_original_transaction_id"),
	CONSTRAINT "payments_google_purchase_token_unique" UNIQUE("google_purchase_token")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_price_id" text,
	"status" text NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_configs" ADD CONSTRAINT "book_configs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_notes" ADD CONSTRAINT "book_notes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_shares" ADD CONSTRAINT "book_shares_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replica_keys" ADD CONSTRAINT "replica_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replicas" ADD CONSTRAINT "replicas_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_iap_subscriptions" ADD CONSTRAINT "apple_iap_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_iap_subscriptions" ADD CONSTRAINT "google_iap_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "idx_files_user_id_deleted_at" ON "files" USING btree ("user_id","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_files_file_key" ON "files" USING btree ("file_key");--> statement-breakpoint
CREATE INDEX "idx_files_file_key_deleted_at" ON "files" USING btree ("file_key","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_files_replica_lookup" ON "files" USING btree ("user_id","replica_kind","replica_id");--> statement-breakpoint
CREATE INDEX "idx_book_shares_user_id" ON "book_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_book_shares_user_id_book_hash" ON "book_shares" USING btree ("user_id","book_hash");--> statement-breakpoint
CREATE INDEX "idx_replicas_pull_cursor" ON "replicas" USING btree ("user_id","kind","updated_at_ts");--> statement-breakpoint
CREATE INDEX "idx_apple_iap_subscriptions_user_id" ON "apple_iap_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_customers_user_id" ON "customers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_google_iap_subscriptions_user_id" ON "google_iap_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_payments_user_id" ON "payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_user_id" ON "subscriptions" USING btree ("user_id");