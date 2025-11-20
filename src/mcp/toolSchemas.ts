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

export const toolInputSchemas = {
  quote_and_preview_letter: z.object({
    sender: addressSchema,
    recipient: addressSchema,
    bodyText: z.string(),
    signOff: z.string()
  }),
  send_letter: z.object({
    sender: addressSchema,
    recipient: addressSchema,
    bodyText: z.string(),
    signOff: z.string(),
    requiredCredits: z.number(),
    confirm: z.boolean()
  }),
  get_order_status: z.object({
    orderId: z.string().optional()
  }),
  get_account_balance: z.object({}).strict(),
  list_orders: z.object({
    limit: z.number().optional()
  })
};

export type ToolInputSchemaName = keyof typeof toolInputSchemas;
