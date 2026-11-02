import { z } from 'zod';
import { objectId, paginationQuery, sortParam } from '../shared/common.validation';

export const adminListDashboardsQuery = paginationQuery.extend({
  projectId: objectId.optional(),
  ownerId: objectId.optional(),
  sort: sortParam(['updatedAt', 'createdAt', 'name'] as const, '-updatedAt'),
});

export const adminDashboardParams = z.object({ id: objectId }).strict();
