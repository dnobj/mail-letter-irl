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
  sender: addressZ,
  recipient: addressZ,
  bodyText: z.string(),
  signOff: z.string()
});

export const sendLetterInputZ = z.object({
  sender: addressZ,
  recipient: addressZ,
  bodyText: z.string(),
  signOff: z.string(),
  requiredCredits: z.number(),
  confirm: z.boolean()
});

export const getOrderStatusInputZ = z.object({
  orderId: z.string().optional()
});

export const getAccountBalanceInputZ = z.object({});
