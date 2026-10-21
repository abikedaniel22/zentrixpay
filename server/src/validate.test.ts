import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod/v4";
import { validate } from "./middleware/validate.js";
import { publisherRegisterSchema } from "./schemas/requests.js";

function mockResponse() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

describe("validate middleware", () => {
  it("passes parsed body to the next handler", () => {
    const schema = z.object({ name: z.string() }).strict();
    const req = { body: { name: "ZentrixPay" } } as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    validate(schema)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toEqual({ name: "ZentrixPay" });
  });

  it("returns field-level 400 errors for invalid input", () => {
    const req = { body: { name: "", email: "not-an-email" } } as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    validate(publisherRegisterSchema)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          _errors: expect.any(Array),
        }),
      }),
    );
  });

  it("rejects unknown fields with strict schemas", () => {
    const req = {
      body: { name: "Alice", email: "alice@example.com", walletAddress: "GALICE", extra: true },
    } as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    validate(publisherRegisterSchema)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
