import { z } from "zod";

export const ADMIN_SUMMARY_MAX_BYTES = 32_768;
export const ADMIN_OPERATION_PAYLOAD_MAX_BYTES = 65_536;

export const AdminEnvironmentSchema = z.enum(["development", "production"]);
export const AdminModeSchema = z.enum(["read-only", "full"]);
export const AdminAuditOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "denied",
]);
export const AdminCommandStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "rejected",
]);
export const AdminOperationStatusSchema = z.enum([
  "pending",
  "processing",
  "succeeded",
  "failed",
]);

export type AdminEnvironment = z.infer<typeof AdminEnvironmentSchema>;
export type AdminMode = z.infer<typeof AdminModeSchema>;

export type AdminJsonValue =
  | string
  | number
  | boolean
  | null
  | AdminJsonValue[]
  | { [key: string]: AdminJsonValue };

export type AdminJsonObject = { [key: string]: AdminJsonValue };

export const AdminJsonValueSchema: z.ZodType<AdminJsonValue> = z.lazy(() =>
  z.union([
    z.string().max(4096),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(AdminJsonValueSchema).max(100),
    z.record(z.string().max(128), AdminJsonValueSchema),
  ]),
);

export function boundedAdminJsonObjectSchema(maxBytes: number) {
  return z
    .record(z.string().max(128), AdminJsonValueSchema)
    .superRefine((value, context) => {
      if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `JSON value exceeds ${maxBytes} bytes`,
        });
      }
    });
}

const IdentifierSchema = z.string().trim().min(1).max(255);
const ActionSchema = z.string().trim().min(1).max(100);
const SidSchema = z
  .string()
  .regex(/^S-\d(?:-\d+)+$/)
  .max(255);
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const ErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);

export const AdminErrorEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: ErrorCodeSchema,
        message: z.string().min(1).max(500),
        correlationId: z.string().uuid(),
      })
      .strict(),
  })
  .strict();

export function adminSuccessEnvelopeSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({ ok: z.literal(true), data }).strict();
}

export const AdminActorSchema = z
  .object({
    sid: SidSchema,
    name: z.string().trim().min(1).max(255),
  })
  .strict();

export const AdminPageRequestSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().trim().min(1).max(500).optional(),
    search: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const AdminAuditEventInputSchema = z
  .object({
    actor: AdminActorSchema,
    environment: AdminEnvironmentSchema,
    mode: AdminModeSchema,
    sessionIdHash: DigestSchema,
    correlationId: z.string().uuid(),
    action: ActionSchema,
    targetType: ActionSchema,
    targetId: IdentifierSchema.optional(),
    reason: z.string().trim().min(1).max(1000).optional(),
    inputSummary: boundedAdminJsonObjectSchema(ADMIN_SUMMARY_MAX_BYTES).default(
      {},
    ),
    beforeSummary: boundedAdminJsonObjectSchema(
      ADMIN_SUMMARY_MAX_BYTES,
    ).default({}),
    afterSummary: boundedAdminJsonObjectSchema(ADMIN_SUMMARY_MAX_BYTES).default(
      {},
    ),
    outcome: AdminAuditOutcomeSchema,
    errorCode: ErrorCodeSchema.optional(),
    commandId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === "succeeded" && value.errorCode !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: "Successful audit events cannot include an error code",
      });
    }
    if (value.outcome !== "succeeded" && value.errorCode === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: "Failed and denied audit events require a stable error code",
      });
    }
  });

export const AdminCommandRunInputSchema = z
  .object({
    idempotencyKey: IdentifierSchema,
    actorSid: SidSchema,
    environment: AdminEnvironmentSchema,
    action: ActionSchema,
    targetType: ActionSchema,
    targetId: IdentifierSchema.optional(),
    previewDigest: DigestSchema,
    expectedVersion: IdentifierSchema.optional(),
    correlationId: z.string().uuid(),
  })
  .strict();

export const AdminCommandRunSchema = z
  .object({
    id: z.string().uuid(),
    idempotencyKey: IdentifierSchema,
    actorSid: SidSchema,
    environment: AdminEnvironmentSchema,
    action: ActionSchema,
    targetType: ActionSchema,
    targetId: IdentifierSchema.nullable(),
    previewDigest: DigestSchema,
    expectedVersion: IdentifierSchema.nullable(),
    status: AdminCommandStatusSchema,
    requestedAt: z.coerce.date(),
    startedAt: z.coerce.date().nullable(),
    completedAt: z.coerce.date().nullable(),
    correlationId: z.string().uuid(),
    sanitizedResult: boundedAdminJsonObjectSchema(
      ADMIN_SUMMARY_MAX_BYTES,
    ).nullable(),
    errorCode: ErrorCodeSchema.nullable(),
  })
  .strict();

export const AdminCommandCompletionSchema = z
  .object({
    commandId: z.string().uuid(),
    status: z.enum(["succeeded", "failed", "rejected"]),
    sanitizedResult: boundedAdminJsonObjectSchema(
      ADMIN_SUMMARY_MAX_BYTES,
    ).optional(),
    errorCode: ErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded" && value.errorCode !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: "Successful commands cannot include an error code",
      });
    }
    if (value.status !== "succeeded" && value.errorCode === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: "Failed and rejected commands require a stable error code",
      });
    }
  });

export const AdminCommandConfirmationSchema = z
  .object({
    previewDigest: DigestSchema,
    reason: z.string().trim().min(1).max(1000),
    idempotencyKey: IdentifierSchema,
    expectedVersion: IdentifierSchema.optional(),
  })
  .strict();

export type AdminAuditEventInput = z.input<typeof AdminAuditEventInputSchema>;
export type AdminCommandRunInput = z.input<typeof AdminCommandRunInputSchema>;
export type AdminCommandRun = z.output<typeof AdminCommandRunSchema>;
export type AdminCommandCompletion = z.input<
  typeof AdminCommandCompletionSchema
>;
