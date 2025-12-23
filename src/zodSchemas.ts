import { z } from "zod";

export const addressZ = z.object({
  name: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().optional(),
  city: z.string(),
  state: z.string(),
  postalCode: z.string(),
  country: z.string()
});

export const quoteAndPreviewInputZ = z.object({
  sender: addressZ.optional(),  // Optional - will use saved return address if not provided
  recipient: addressZ,
  bodyText: z.string(),
  signOff: z.string()
});

export const sendLetterInputZ = z.object({
  draftId: z.string(),
  confirm: z.boolean()
});

export const getOrderStatusInputZ = z.object({
  orderId: z.string().optional()
});

export const getAccountBalanceInputZ = z.object({});

export const listOrdersInputZ = z.object({
  limit: z.number().optional()
});

export const setReturnAddressInputZ = z.object({
  name: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().optional(),
  city: z.string(),
  state: z.string(),
  postalCode: z.string(),
  country: z.string().optional()
});

export const getReturnAddressInputZ = z.object({});

export const clearReturnAddressInputZ = z.object({
  confirm: z.boolean()
});
