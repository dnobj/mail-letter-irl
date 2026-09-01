import { z } from "zod";

const addressSchema = z.object({
  name: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().optional(),
  city: z.string(),
  state: z.string(),
  postalCode: z.string(),
  country: z.string()
});

// Image file param schema - the OpenAI Apps SDK file-param contract requires
// the SERVED JSON schema to be exactly an object declaring all four of
// download_url/file_id/mime_type/file_name with only the first two required.
// Anything else - including the anyOf this used to serialize to as a
// union-with-string - is silently rejected by the platform's tool scan, which
// strips the property's schema to {} and disables the file transform for the
// tool entirely (issue #227: ChatGPT's stored schema literally showed
// "image": {}, and the model could only improvise bare id/path strings).
//
// The union existed because ChatGPT mobile sends strings ('' when nothing is
// attached, and per openai-apps-sdk-examples#185 also 'chat_upload' /
// 'chat_upload://image_N') instead of file objects. That tolerance now lives
// in the preprocess step, which zod-to-json-schema serializes as the INNER
// object (contract-conformant) while at runtime coercing any string to
// undefined - landing on the handlers' existing graceful no-image fallback.
const imageFileParamSchema = z.preprocess(
  (value) => (typeof value === "string" ? undefined : value),
  z
    .object({
      download_url: z.string(),
      file_id: z.string(),
      mime_type: z.string().optional(),
      file_name: z.string().optional()
    })
    .optional()
);

export const toolInputSchemas = {
  // Letter tools - three separate tools for different layouts
  quote_and_preview_letter: z.object({
    sender: addressSchema.optional(),  // Optional - will use saved return address if not provided
    recipient: addressSchema,
    bodyText: z.string(),
    signOff: z.string()
  }),
  quote_and_preview_letter_with_header_image: z.object({
    sender: addressSchema.optional(),
    recipient: addressSchema,
    bodyText: z.string(),
    signOff: z.string(),
    // Image from file attachment - OpenAI Apps SDK requires explicit schema definition
    image: imageFileParamSchema.optional(),
    // Alternative: direct image URL
    imageUrl: z.string().optional()
  }),
  quote_and_preview_letter_with_image: z.object({
    sender: addressSchema.optional(),
    recipient: addressSchema,
    bodyText: z.string(),
    signOff: z.string(),
    // Image from file attachment - OpenAI Apps SDK requires explicit schema definition
    image: imageFileParamSchema.optional(),
    // Alternative: direct image URL
    imageUrl: z.string().optional()
  }),
  send_letter: z.object({
    draftId: z.string(),
    confirm: z.boolean()
  }),
  create_mail_checkout: z.object({
    draftId: z.string()
  }),
  create_pack_checkout: z.object({
    pack: z.enum(["starter", "regular", "power"])
  }),
  redeem_promo_code: z.object({
    code: z.string()
  }),
  get_purchase_status: z.object({
    orderId: z.string()
  }),
  // Account and order management tools
  get_order_status: z.object({
    orderId: z.string().optional()
  }),
  get_account_balance: z.object({}).strict(),
  list_orders: z.object({
    limit: z.number().optional()
  }),
  set_return_address: z.object({
    name: z.string(),
    addressLine1: z.string(),
    addressLine2: z.string().optional(),
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
    country: z.string().optional()
  }),
  get_return_address: z.object({}).strict(),
  clear_return_address: z.object({
    confirm: z.boolean()
  }),
  // Postcard tools
  quote_and_preview_postcard: z.object({
    sender: addressSchema.optional(),  // Optional - will use saved return address if not provided
    recipient: addressSchema,
    message: z.string(),
    size: z.enum(["6x9"]).optional(),
    // Image from file attachment - OpenAI Apps SDK requires explicit schema definition
    image: imageFileParamSchema.optional(),
    // Alternative: direct image URL
    imageUrl: z.string().optional()
  }),
  send_postcard: z.object({
    draftId: z.string(),
    confirm: z.boolean()
  }),
  // Feedback tools
  submit_feature_request: z.object({
    title: z.string(),
    description: z.string(),
    category: z.enum([
      "new_feature",
      "improvement",
      "integration",
      "mail_type",
      "international",
      "other"
    ]).optional(),
    attemptedAction: z.string().optional(),
    contactEmail: z.string().optional(),
    okToContact: z.boolean().optional()
  }),
  get_started: z.object({}).strict(),
  // Image upload tool
  upload_image: z.object({
    context: z.string().optional()
  }),
  // Hybrid image tool (generates with credits; routes otherwise)
  generate_image_for_mail: z.object({
    prompt: z.string().optional(),
    context: z.enum(["postcard", "header_image", "inline_image"]).optional()
  }),
  // Confirm uploaded image tool (widget relay)
  confirm_uploaded_image: z.object({
    imageUrl: z.string(),
    context: z.string().optional()
  })
};

export type ToolInputSchemaName = keyof typeof toolInputSchemas;
