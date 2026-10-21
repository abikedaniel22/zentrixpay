import {
  createIpRateLimiter,
  createWalletRateLimiter,
} from "../middleware/rateLimit.js";
import { config } from "../config.js";
import { getRateLimitStore } from "../lib/rateLimit/index.js";
import type { RequestHandler } from "express";

const store = getRateLimitStore();

export const publishIpRateLimit: RequestHandler = createIpRateLimiter(
  store,
  "publish",
  config.RATE_LIMIT_PUBLISH_IP_MAX,
  config.RATE_LIMIT_PUBLISH_IP_WINDOW_MS,
  "publish_ip",
);

export const publishWalletRateLimit: RequestHandler = createWalletRateLimiter(
  store,
  "publish",
  config.RATE_LIMIT_PUBLISH_WALLET_MAX,
  config.RATE_LIMIT_PUBLISH_WALLET_WINDOW_MS,
  (req) => req.publisher?.walletAddress,
  "publish_wallet",
);
