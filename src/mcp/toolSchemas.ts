import { z } from "zod";
import { preprocessImageFileParam } from "../utils/imageFileParam.js";

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
// object (contract-conformant). At runtime '' becomes no image and any other
// string becomes a marker for a picture the server cannot open (#414; see
// utils/imageFileParam.ts). Same preprocess as src/zodSchemas.ts.
const imageFileParamSchema = z.preprocess(
  preprocessImageFileParam,
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
    signOff: z.string(),
    sendAsGift: z.boolean().optional(),
    arriveBy: z.string().optional(),
    stationery: z.string().optional(),
    monogram: z.string().optional(),
    headline: z.string().optional()
  }),
  quote_and_preview_letter_with_header_image: z.object({
    sender: addressSchema.optional(),
    recipient: addressSchema,
    bodyText: z.string(),
    signOff: z.string(),
    // Image from file attachment - OpenAI Apps SDK requires explicit schema definition
    image: imageFileParamSchema.optional(),
    // Alternative: direct image URL
    imageUrl: z.string().optional(),
    sendAsGift: z.boolean().optional(),
    arriveBy: z.string().optional(),
    stationery: z.string().optional(),
    monogram: z.string().optional(),
    headline: z.string().optional()
  }),
  quote_and_preview_letter_with_image: z.object({
    sender: addressSchema.optional(),
    recipient: addressSchema,
    bodyText: z.string(),
    signOff: z.string(),
    // Image from file attachment - OpenAI Apps SDK requires explicit schema definition
    image: imageFileParamSchema.optional(),
    // Alternative: direct image URL
    imageUrl: z.string().optional(),
    sendAsGift: z.boolean().optional(),
    arriveBy: z.string().optional(),
    stationery: z.string().optional(),
    monogram: z.string().optional(),
    headline: z.string().optional()
  }),
  send_letter: z.object({
    draftId: z.string(),
    confirm: z.boolean(),
    sendAnotherCopy: z.boolean().optional()
  }),
  create_mail_checkout: z.object({
    draftId: z.string(),
    sendAnotherCopy: z.boolean().optional()
  }),
  list_letter_packs: z.object({}),
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
  get_profile: z.object({}).strict(),
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
    // The 4x6 and 11x6 while offered (#594); zodSchemas.ts serves each state.
    size: z.enum(["6x9", "6x4", "6x11"]).optional(),
    // The front's layout while layouts are offered (#594).
    layout: z.enum(["full_bleed", "border", "greetings"]).optional(),
    caption: z.string().optional(),
    place: z.string().optional(),
    // Image from file attachment - OpenAI Apps SDK requires explicit schema definition
    image: imageFileParamSchema.optional(),
    // Alternative: direct image URL
    imageUrl: z.string().optional(),
    sendAsGift: z.boolean().optional(),
    arriveBy: z.string().optional()
  }),
  send_postcard: z.object({
    draftId: z.string(),
    confirm: z.boolean(),
    sendAnotherCopy: z.boolean().optional()
  }),
  // A link where the person sends a preview themselves (#470)
  request_send: z.object({
    draftId: z.string()
  }),
  // What became of a preview's draft, for the card (#474)
  get_draft_status: z.object({
    draftId: z.string()
  }),
  // A preview's arrival date, changed without previewing again (#535)
  set_arrival_date: z.object({
    draftId: z.string(),
    arriveBy: z.string().optional()
  }),
  // A letter preview's stationery, changed without previewing again (#563)
  set_stationery: z.object({
    draftId: z.string(),
    stationery: z.string(),
    monogram: z.string().optional(),
    headline: z.string().optional()
  }),
  // A letter preview's words, changed without previewing again (#586)
  set_letter_words: z.object({
    draftId: z.string(),
    bodyText: z.string(),
    signOff: z.string(),
    wordsVersion: z.string().optional()
  }),
  // A postcard preview's size and front, changed without previewing again (#594)
  set_postcard_style: z.object({
    draftId: z.string(),
    size: z.string().optional(),
    layout: z.string().optional(),
    caption: z.string().optional(),
    place: z.string().optional()
  }),
  // Held mail cancelled before it goes to the printer (#535)
  cancel_scheduled_mail: z.object({
    orderId: z.string(),
    confirm: z.boolean()
  }),
  // One chunk of a photo from the upload card (#474, phase 3)
  upload_photo_chunk: z.object({
    uploadId: z.string(),
    index: z.number(),
    total: z.number(),
    data: z.string(),
    context: z.enum(["postcard", "header_image", "inline_image"]).optional()
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
