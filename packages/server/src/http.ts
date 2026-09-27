import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  BALANCE_HEADER,
  NEXT_CUMULATIVE_HEADER,
  PAYER_HEADER,
  formatUnits,
  type L402ErrorCode,
} from "@l402-el2/core";
import type { AuthorizeResult, Gatekeeper } from "./gatekeeper.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the L402 middleware when the payment is valid. */
      l402?: {
        payer: `0x${string}`;
        channelId: `0x${string}`;
        price: bigint;
        cumulativeAmount: bigint;
        remaining: bigint;
      };
    }
  }
}

export interface L402MiddlewareOptions {
  /**
   * Maps the request to a resource name (and therefore a price).
   * Default: the path.
   */
  resourceOf?: (req: Request) => string;
  /** Returns true if the request is free (health checks, discovery, ...). */
  isFree?: (req: Request) => boolean;
}

/** HTTP status for an L402 error: 402 "you must pay", 401 broken or revoked credentials. */
export function statusFor(code: L402ErrorCode): number {
  switch (code) {
    case "invalid_macaroon":
    case "malformed_credentials":
    case "revoked":
    case "caveat_failed":
    case "macaroon_expired":
      return 401;
    case "rate_limited":
      return 429;
    default:
      return 402;
  }
}

/** Response headers shared by the HTTP and MCP middlewares. */
export function setPaymentHeaders(res: Response, result: AuthorizeResult): void {
  if (result.ok) {
    res.setHeader(BALANCE_HEADER, result.remaining.toString());
    res.setHeader(NEXT_CUMULATIVE_HEADER, (result.cumulativeAmount + result.price).toString());
    return;
  }
  res.setHeader("WWW-Authenticate", result.challenge.header);
  if (result.challenge.paymentRequest.cumulativeAmount) {
    res.setHeader(NEXT_CUMULATIVE_HEADER, result.challenge.paymentRequest.cumulativeAmount);
  }
}

/**
 * Express middleware that protects routes with L402-EL2.
 *
 * Flow:
 *   request without credentials  -> 402 + WWW-Authenticate
 *   request with a valid voucher -> next()
 * Resources priced at 0 are passed through without asking for payment.
 */
export function l402Middleware(gatekeeper: Gatekeeper, options: L402MiddlewareOptions = {}): RequestHandler {
  const resourceOf = options.resourceOf ?? ((req: Request) => req.path);

  return async (req: Request, res: Response, next: NextFunction) => {
    if (options.isFree?.(req)) return next();

    const resource = resourceOf(req);
    if (gatekeeper.priceOf(resource) === 0n) return next();

    try {
      const payerHint = req.header(PAYER_HEADER);
      const result = await gatekeeper.authorize({
        authorization: req.header("authorization"),
        resource,
        ...(payerHint ? { payerHint } : {}),
      });
      setPaymentHeaders(res, result);

      if (!result.ok) {
        res.status(statusFor(result.code)).json({
          error: result.code,
          message: result.reason,
          payment: result.challenge.paymentRequest,
        });
        return;
      }

      req.l402 = {
        payer: result.payer,
        channelId: result.channelId,
        price: result.price,
        cumulativeAmount: result.cumulativeAmount,
        remaining: result.remaining,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Serves `/.well-known/l402` with the service configuration. */
export function l402Discovery(gatekeeper: Gatekeeper): RequestHandler {
  return (_req, res) => {
    res.json(gatekeeper.discovery());
  };
}

/** Formats an amount for logs (satoshis -> "0.00001 cbBTC"). */
export function humanAmount(amount: bigint, decimals: number, symbol: string): string {
  return `${formatUnits(amount, decimals)} ${symbol}`;
}
