import { Types } from 'mongoose';
import { badRequest } from './error.util';

/** Convert a validated id string to an ObjectId. Ids are validated by Zod first; this is a final guard. */
export function oid(id: string | Types.ObjectId): Types.ObjectId {
  if (id instanceof Types.ObjectId) return id;
  if (typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id)) throw badRequest('An identifier in the request is malformed.');
  return new Types.ObjectId(id);
}

export const newId = () => new Types.ObjectId();

export const sid = (v: Types.ObjectId | string | null | undefined): string | null => (v ? String(v) : null);

export const sameId = (a: Types.ObjectId | string | null | undefined, b: Types.ObjectId | string | null | undefined) =>
  Boolean(a && b && String(a) === String(b));
