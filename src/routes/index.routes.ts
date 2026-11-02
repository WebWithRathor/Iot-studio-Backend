import { Router } from 'express';
import { PRIVATE_AREA_MIN_ROLE } from '../constants/role-hierarchy.constants';
import { healthController } from '../controllers/public/health.controller';
import { authenticate } from '../middleware/authenticate.middleware';
import { authorizeRole } from '../middleware/authorize-role.middleware';
import { generalLimiter } from '../middleware/rate-limit.middleware';
import { adminRoutes } from './private/admin.routes';
import { auditLogRoutes } from './private/audit-log.routes';
import { dashboardManagementRoutes } from './private/dashboard-management.routes';
import { deviceManagementRoutes } from './private/device-management.routes';
import { kitCodeManagementRoutes } from './private/kit-code-management.routes';
import { mqttManagementRoutes } from './private/mqtt-management.routes';
import { projectManagementRoutes } from './private/project-management.routes';
import { userManagementRoutes } from './private/user-management.routes';
import { authRoutes } from './public/auth.routes';
import { dashboardRoutes, projectDashboardRoutes } from './public/dashboard.routes';
import { deviceRoutes } from './public/device.routes';
import { mqttRoutes } from './public/mqtt.routes';
import { paymentRoutes } from './public/payment.routes';
import { projectRoutes } from './public/project.routes';
import { userRoutes } from './public/user.routes';
import { projectVariableRoutes, variableRoutes } from './public/variable.routes';
import { widgetRoutes } from './public/widget.routes';

/**
 * API surface (mounted at API_BASE_PATH, default /api/v1):
 *
 *   PUBLIC (user area — authenticated unless noted, always owner-scoped)
 *     /health, /health/ready         anonymous
 *     /auth/*                        see auth.routes.ts
 *     /users/me/*                    profile, preferences, password, workspace, activity
 *     /projects/*                    projects, export/import, device associations, activity
 *     /projects/:projectId/dashboards, /dashboards/*      dashboards + widget layout
 *     /dashboards/:id/widgets/*      single widgets
 *     /projects/:projectId/variables, /variables/*        variables
 *     /devices/*                     own devices, simulated device creation, demo states
 *     /mqtt/*                        snapshot, history, commands, SSE stream
 *
 *   PRIVATE (/admin — authenticate + role ≥ ADMIN at the mount, then per-route permissions)
 *     /admin/overview, /admin/users, /admin/projects, /admin/dashboards,
 *     /admin/devices, /admin/mqtt, /admin/audit-logs, /admin/kit-codes
 */
export function buildRouter(): Router {
  const api = Router();

  api.get('/health', healthController.live);
  api.get('/health/ready', healthController.ready);

  api.use(generalLimiter());

  // public — nested collection routers first, so /projects/:id doesn't shadow them
  api.use('/auth', authRoutes);
  api.use('/users', userRoutes);
  api.use('/projects/:projectId/dashboards', projectDashboardRoutes);
  api.use('/projects/:projectId/variables', projectVariableRoutes);
  api.use('/projects', projectRoutes);
  api.use('/dashboards', dashboardRoutes);
  api.use('/dashboards', widgetRoutes);
  api.use('/variables', variableRoutes);
  api.use('/devices', deviceRoutes);
  api.use('/mqtt', mqttRoutes);
  api.use('/payments', paymentRoutes);

  // private
  const admin = Router();
  admin.use(authenticate, authorizeRole(PRIVATE_AREA_MIN_ROLE));
  admin.use('/', adminRoutes);
  admin.use('/users', userManagementRoutes);
  admin.use('/projects', projectManagementRoutes);
  admin.use('/dashboards', dashboardManagementRoutes);
  admin.use('/devices', deviceManagementRoutes);
  admin.use('/mqtt', mqttManagementRoutes);
  admin.use('/audit-logs', auditLogRoutes);
  admin.use('/kit-codes', kitCodeManagementRoutes);
  api.use('/admin', admin);

  return api;
}
