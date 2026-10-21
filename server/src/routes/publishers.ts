import { Router, type Router as RouterType } from "express";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { validate } from "../middleware/validate.js";
import { publisherRegisterSchema } from "../schemas/requests.js";
import { requestSignatureAuth } from "../middleware/requestSignatureAuth.js";
import { registerPublisher, rotatePublisherKey } from "../services/publisherService.js";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { publishers } from "../db/schema.js";

const router: RouterType = Router();

// POST /publishers — register a new publisher (public)
router.post("/publishers", validate(publisherRegisterSchema), async (req, res) => {
  try {
    const { publisher, apiKey } = await registerPublisher(req.body);
    res.status(201).json({
      id: publisher.id,
      name: publisher.name,
      email: publisher.email,
      walletAddress: publisher.walletAddress,
      apiKey, // shown once — store it securely
      createdAt: publisher.createdAt,
    });
  } catch (err: any) {
    if (err.message?.includes("unique")) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }
    throw err;
  }
});

// GET /publishers/wallet/:address — look up publisher by wallet (public)
router.get("/publishers/wallet/:address", async (req, res) => {
  const address = req.params.address as string;
  const publisher = await db
    .select({
      id: publishers.id,
      name: publishers.name,
      email: publishers.email,
      walletAddress: publishers.walletAddress,
      createdAt: publishers.createdAt,
    })
    .from(publishers)
    .where(eq(publishers.walletAddress, address))
    .then((rows) => rows[0] ?? null);

  if (!publisher) {
    res.status(404).json({ error: "No publisher found for this wallet" });
    return;
  }

  res.json(publisher);
});

// GET /publishers/me — own profile (authenticated)
router.get("/publishers/me", apiKeyAuth, async (req, res) => {
  const pub = req.publisher!;
  res.json({
    id: pub.id,
    name: pub.name,
    email: pub.email,
    walletAddress: pub.walletAddress,
    createdAt: pub.createdAt,
  });
});

// POST /publishers/me/rotate-key — issue a new API key and invalidate the old one (authenticated)
router.post("/publishers/me/rotate-key", apiKeyAuth, requestSignatureAuth, async (req, res) => {
  const { publisher, apiKey } = await rotatePublisherKey(req.publisher!.id);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    id: publisher.id,
    apiKey, // shown once — store it securely
    rotatedAt: new Date().toISOString(),
  });
});

export default router;
