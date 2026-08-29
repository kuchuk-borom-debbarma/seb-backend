CREATE TABLE "seb_cycle_policy_document" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_cycle_policy_document_version_check" CHECK ("seb_cycle_policy_document"."current_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "seb_cycle_policy_document_scan" (
	"id" text PRIMARY KEY NOT NULL,
	"document_version_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"status" text NOT NULL,
	"scanner_reference" text,
	"safe_message" text,
	"scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_cycle_policy_document_scan_sequence_check" CHECK ("seb_cycle_policy_document_scan"."sequence_number" >= 1),
	CONSTRAINT "seb_cycle_policy_document_scan_status_check" CHECK ("seb_cycle_policy_document_scan"."status" IN ('PENDING', 'ACCEPTED', 'REJECTED', 'ERROR')),
	CONSTRAINT "seb_cycle_policy_document_scan_lifecycle_check" CHECK (("seb_cycle_policy_document_scan"."status" = 'PENDING' AND "seb_cycle_policy_document_scan"."scanned_at" IS NULL)
        OR ("seb_cycle_policy_document_scan"."status" <> 'PENDING' AND "seb_cycle_policy_document_scan"."scanned_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_cycle_policy_document_version" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"version" integer NOT NULL,
	"operation" text NOT NULL,
	"r2_object_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum" text NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_cycle_policy_document_version_r2_object_key_unique" UNIQUE("r2_object_key"),
	CONSTRAINT "seb_cycle_policy_document_version_number_uq" UNIQUE("document_id","version"),
	CONSTRAINT "seb_cycle_policy_document_version_number_check" CHECK ("seb_cycle_policy_document_version"."version" >= 1),
	CONSTRAINT "seb_cycle_policy_document_size_check" CHECK ("seb_cycle_policy_document_version"."size_bytes" >= 0),
	CONSTRAINT "seb_cycle_policy_document_operation_check" CHECK ("seb_cycle_policy_document_version"."operation" IN ('UPLOAD', 'REPLACE'))
);
--> statement-breakpoint
CREATE TABLE "seb_cycle_policy_upload_intent" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"issued_by_user_id" text NOT NULL,
	"expected_document_version" integer NOT NULL,
	"object_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum_sha256" text NOT NULL,
	"status" text DEFAULT 'ISSUED' NOT NULL,
	"cleanup_target_status" text,
	"expires_at" timestamp with time zone NOT NULL,
	"finalized_document_version_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_cycle_policy_upload_intent_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "seb_cycle_policy_upload_intent_status_check" CHECK ("seb_cycle_policy_upload_intent"."status" IN ('ISSUED', 'FINALIZED', 'REJECTED', 'CLEANUP_PENDING', 'EXPIRED')),
	CONSTRAINT "seb_cycle_policy_upload_intent_expected_version_check" CHECK ("seb_cycle_policy_upload_intent"."expected_document_version" >= 0),
	CONSTRAINT "seb_cycle_policy_upload_intent_size_check" CHECK ("seb_cycle_policy_upload_intent"."size_bytes" > 0 AND "seb_cycle_policy_upload_intent"."size_bytes" <= 5242880),
	CONSTRAINT "seb_cycle_policy_upload_intent_lifecycle_check" CHECK (("seb_cycle_policy_upload_intent"."status" = 'FINALIZED'
          AND "seb_cycle_policy_upload_intent"."finalized_document_version_id" IS NOT NULL
          AND "seb_cycle_policy_upload_intent"."cleanup_target_status" IS NULL)
        OR ("seb_cycle_policy_upload_intent"."status" = 'CLEANUP_PENDING'
          AND "seb_cycle_policy_upload_intent"."finalized_document_version_id" IS NULL
          AND "seb_cycle_policy_upload_intent"."cleanup_target_status" IN ('REJECTED', 'EXPIRED'))
        OR ("seb_cycle_policy_upload_intent"."status" NOT IN ('FINALIZED', 'CLEANUP_PENDING')
          AND "seb_cycle_policy_upload_intent"."finalized_document_version_id" IS NULL
          AND "seb_cycle_policy_upload_intent"."cleanup_target_status" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "seb_cycle_policy_document" ADD CONSTRAINT "seb_cycle_policy_document_programme_cycle_id_seb_programme_cycle_id_fk" FOREIGN KEY ("programme_cycle_id") REFERENCES "public"."seb_programme_cycle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_cycle_policy_document_scan" ADD CONSTRAINT "seb_cycle_policy_document_scan_document_version_id_seb_cycle_policy_document_version_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."seb_cycle_policy_document_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_cycle_policy_document_version" ADD CONSTRAINT "seb_cycle_policy_document_version_document_id_seb_cycle_policy_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."seb_cycle_policy_document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_cycle_policy_document_version" ADD CONSTRAINT "seb_cycle_policy_document_version_uploaded_by_user_id_core_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_cycle_policy_upload_intent" ADD CONSTRAINT "seb_cycle_policy_upload_intent_programme_cycle_id_seb_programme_cycle_id_fk" FOREIGN KEY ("programme_cycle_id") REFERENCES "public"."seb_programme_cycle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_cycle_policy_upload_intent" ADD CONSTRAINT "seb_cycle_policy_upload_intent_issued_by_user_id_core_user_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_cycle_policy_upload_intent" ADD CONSTRAINT "seb_cycle_policy_upload_intent_finalized_document_version_id_seb_cycle_policy_document_version_id_fk" FOREIGN KEY ("finalized_document_version_id") REFERENCES "public"."seb_cycle_policy_document_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seb_cycle_policy_document_cycle_uq" ON "seb_cycle_policy_document" USING btree ("programme_cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_cycle_policy_document_scan_sequence_uq" ON "seb_cycle_policy_document_scan" USING btree ("document_version_id","sequence_number");--> statement-breakpoint
CREATE INDEX "seb_cycle_policy_upload_intent_cleanup_idx" ON "seb_cycle_policy_upload_intent" USING btree ("status","expires_at");