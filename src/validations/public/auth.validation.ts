import { z } from 'zod';
import { email, text } from '../shared/common.validation';

/** 10–128 chars, at least one letter and one digit. Length matters more than symbols. */
export const password = z
  .string()
  .min(10, 'must be at least 10 characters')
  .max(128, 'must be at most 128 characters')
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'must contain at least one letter and one digit');

/** Note: no `role` field — registrations always get the default role. `.strict()` rejects attempts to send one. */
export const registerBody = z
  .object({
    name: text(80, 2),
    email,
    password,
  })
  .strict();

export const loginBody = z
  .object({
    email,
    password: z.string().min(1, 'is required').max(128),
  })
  .strict();

export const emptyBody = z.object({}).strict().optional();
