import { z } from 'zod';
import { text } from '../shared/common.validation';
import { password } from './auth.validation';

export const updateProfileBody = z.object({ name: text(80, 2) }).strict();

export const updatePreferencesBody = z
  .object({
    onboardingDismissed: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'send at least one preference');

export const changePasswordBody = z
  .object({
    /** Empty only for an LMS-created account setting its first password (checked in the service). */
    currentPassword: z.string().max(128).default(''),
    newPassword: password,
  })
  .strict()
  .refine((v) => v.currentPassword !== v.newPassword, { message: 'must differ from the current password', path: ['newPassword'] });

/** Format is checked in the service (normalised: case, spaces and dashes are ignored). */
export const redeemKitBody = z.object({ code: z.string().trim().min(1).max(40) }).strict();

export const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().min(0).optional(),
});
