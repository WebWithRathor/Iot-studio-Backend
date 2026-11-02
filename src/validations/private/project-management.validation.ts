import { z } from 'zod';
import { objectId, paginationQuery, searchQuery, sortParam } from '../shared/common.validation';

export const adminListProjectsQuery = paginationQuery.extend({
  q: searchQuery,
  ownerId: objectId.optional(),
  sort: sortParam(['updatedAt', 'createdAt', 'name'] as const, '-updatedAt'),
});

export const adminDeleteProjectBody = z.object({ reason: z.string().trim().min(3, 'state a reason').max(300) }).strict();
