import type { Request, Response } from 'express';
import type { z } from 'zod';
import { paymentService } from '../../services/public/payment.service';
import { sendSuccess } from '../../utils/api-response.util';
import { asyncHandler } from '../../utils/async-handler.util';
import type { cancelPaymentBody, createOrderBody, mockCompleteBody, verifyPaymentBody } from '../../validations/public/payment.validation';

export const paymentController = {
  catalog: asyncHandler(async (req, res) => sendSuccess(req, res, await paymentService.catalog())),

  history: asyncHandler(async (req, res) => sendSuccess(req, res, await paymentService.history(req.user!.id))),

  createOrder: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof createOrderBody>;
    sendSuccess(req, res, await paymentService.createOrder(req.user!.id, body.productId, { name: req.user!.name, email: req.user!.email }), { status: 201 });
  }),

  verify: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof verifyPaymentBody>;
    sendSuccess(req, res, await paymentService.verify(req.user!.id, body), { message: 'Payment confirmed — tokens added' });
  }),

  completeMock: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof mockCompleteBody>;
    sendSuccess(req, res, await paymentService.completeMock(req.user!.id, body.paymentId, body.outcome));
  }),

  cancel: asyncHandler(async (req, res) => {
    const body = req.validated.body as z.infer<typeof cancelPaymentBody>;
    sendSuccess(req, res, await paymentService.cancel(req.user!.id, body.paymentId, body.reason));
  }),

  /** Raw-body webhook (mounted before the JSON parser and CSRF check in app.ts). */
  webhook: asyncHandler(async (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    sendSuccess(req, res, await paymentService.webhook(raw, req.get('x-razorpay-signature') ?? undefined));
  }),
};
