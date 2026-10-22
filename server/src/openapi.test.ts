import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { openApiSpec } from "./openapi.js";
import docsRouter from "./routes/docs.js";

// Issue #138: the pay-per-call product routes must be discoverable in the
// generated spec (Swagger UI at /docs, clients generated from /openapi.json).

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

type Op = {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{ name?: string; $ref?: string }>;
  responses: Record<string, unknown>;
};

function op(path: string, method: string): Op {
  const item = openApiSpec.paths[path];
  expect(item, `missing path ${path}`).toBeDefined();
  const operation = item[method] as Op | undefined;
  expect(operation, `missing ${method.toUpperCase()} ${path}`).toBeDefined();
  return operation!;
}

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

function resolve(pointer: string): unknown {
  return pointer
    .replace(/^#\//, "")
    .split("/")
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], openApiSpec);
}

describe("OpenAPI spec — pay-per-call routes (#138)", () => {
  it("is an OpenAPI 3 document", () => {
    expect(openApiSpec.openapi).toMatch(/^3\./);
    expect(openApiSpec.info.title).toBeTruthy();
  });

  it.each([
    ["/apis", "get"],
    ["/apis", "post"],
    ["/apis/{id}", "get"],
    ["/apis/{id}", "patch"],
    ["/apis/{id}", "delete"],
    ["/apis/{id}/openapi.json", "get"],
    ["/apis/{id}/verify-ownership", "post"],
    ["/apis/{id}/stats", "get"],
    ["/apis/{id}/stats/time-series", "get"],
    ["/payers/{address}/calls", "get"],
    ["/publishers", "post"],
    ["/publishers/me/apis", "get"],
    ["/api/{id}/pass", "post"],
  ])("documents %s %s", (path, method) => {
    expect(op(path, method).responses).toBeDefined();
  });

  it("documents every proxy method with and without an upstream path", () => {
    for (const path of ["/api/{id}", "/api/{id}/{path}"]) {
      for (const method of HTTP_METHODS) op(path, method);
    }
  });

  it("requires the publisher API key on management and statistics routes", () => {
    const authed: Array<[string, string]> = [
      ["/apis", "post"],
      ["/apis/{id}", "patch"],
      ["/apis/{id}", "delete"],
      ["/apis/{id}/verify-ownership", "post"],
      ["/apis/{id}/stats", "get"],
      ["/apis/{id}/stats/time-series", "get"],
      ["/publishers/me/apis", "get"],
    ];
    for (const [path, method] of authed) {
      expect(op(path, method).security, `${method} ${path}`).toEqual([{ ApiKeyAuth: [] }]);
      expect(op(path, method).responses["401"], `${method} ${path}`).toBeDefined();
    }
    expect(openApiSpec.components.securitySchemes.ApiKeyAuth).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "x-api-key",
    });
  });

  it("keeps public catalog routes unauthenticated", () => {
    expect(op("/apis", "get").security).toBeUndefined();
    expect(op("/apis/{id}", "get").security).toBeUndefined();
  });

  it("describes x402 behaviour on the proxy", () => {
    for (const path of ["/api/{id}", "/api/{id}/{path}"]) {
      for (const method of HTTP_METHODS) {
        const operation = op(path, method);
        expect(operation.responses["402"]).toEqual({
          $ref: "#/components/responses/PaymentRequired",
        });
        for (const status of ["404", "405", "429", "502", "504"]) {
          expect(operation.responses[status], `${method} ${path} ${status}`).toBeDefined();
        }
      }
    }
    const paymentRequired = openApiSpec.components.responses.PaymentRequired as {
      headers: Record<string, unknown>;
    };
    expect(paymentRequired.headers["PAYMENT-REQUIRED"]).toBeDefined();
    expect(openApiSpec.components.securitySchemes.X402Payment).toMatchObject({
      name: "PAYMENT-SIGNATURE",
    });
  });

  it("documents limit/offset pagination on list endpoints", () => {
    for (const path of ["/apis", "/payers/{address}/calls"]) {
      const refs = (op(path, "get").parameters ?? []).map((p) => p.$ref);
      expect(refs).toContain("#/components/parameters/Limit");
      expect(refs).toContain("#/components/parameters/Offset");
    }
  });

  it("documents rate limiting on public registration", () => {
    expect(op("/publishers", "post").responses["429"]).toEqual({
      $ref: "#/components/responses/TooManyRequests",
    });
  });

  it("uses unique operation ids", () => {
    const ids = Object.values(openApiSpec.paths).flatMap((item) =>
      HTTP_METHODS.map((m) => (item[m] as Op | undefined)?.operationId).filter(Boolean),
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only references components that exist", () => {
    const refs = collectRefs(openApiSpec);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(resolve(r), r).toBeDefined();
  });

  it("is served at /openapi.json", async () => {
    const app = express();
    app.use(docsRouter);

    const res = await request(app).get("/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.paths["/apis"]).toBeDefined();
    expect(res.body.paths["/api/{id}/{path}"]).toBeDefined();
  });
});
