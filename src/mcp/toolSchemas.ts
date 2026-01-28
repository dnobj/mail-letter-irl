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

// Image file param schema - OpenAI Apps SDK requires explicit definition
// Union allows both object (valid image) and string (empty from ChatGPT mobile)
// ChatGPT mobile sends image: '' when no file is attached instead of omitting the field
const imageFileParamSchema = z.union([
  z.object({
    download_url: z.string(),
    file_id: z.string()
  }),
  z.string()
]);

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
  })
};

export type ToolInputSchemaName = keyof typeof toolInputSchemas;
