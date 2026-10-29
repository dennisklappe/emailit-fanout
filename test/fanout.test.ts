import { afterEach, describe, expect, it, vi } from "vitest";
import { deliver } from "../src/deliver";
import { shouldDeliver } from "../src/filter";
import worker, { parseDestinations } from "../src/index";
import { sign, verifyEmailit } from "../src/verify";

const SECRET = "whsec_4f2a9c1e7b3d5a8f0e6c2b9d4a7f1e3c5b8d0a2f6e9c3b7d1a5f8e2c4b6d9a0f";
const TS = "1790846045";
const BODY = '[{"event_id":"evt_2xGk7Nq1VbD5sR8tLmW3eYhC6aP","type":"email.delivered"}]';
const SIG = "7242b580f77ec488f8ac21b57f092e3db61a431694f13074c7b4c85a4dd04be3";

const ev = (type: string, from: string, to: unknown) => ({ event_id: "evt_1", type, object: { from, to } });

afterEach(() => vi.unstubAllGlobals());

describe("signature", () => {
  it("matches the Emailit test vector", async () => {
    expect(await sign(SECRET, TS, BODY)).toBe(SIG);
    expect(await verifyEmailit(SECRET, BODY, SIG, TS, Number(TS))).toBe(true);
  });
  it("rejects wrong signature, tampered body, stale or missing timestamp", async () => {
    expect(await verifyEmailit(SECRET, BODY, "0".repeat(64), TS, Number(TS))).toBe(false);
    expect(await verifyEmailit(SECRET, BODY + " ", SIG, TS, Number(TS))).toBe(false);
    expect(await verifyEmailit(SECRET, BODY, SIG, TS, Number(TS) + 301)).toBe(false);
    expect(await verifyEmailit(SECRET, BODY, SIG, null, Number(TS))).toBe(false);
    expect(await verifyEmailit(SECRET, BODY, null, TS, Number(TS))).toBe(false);
  });
});

describe("filters", () => {
  const e = ev("email.bounced", "Shop <hi@shop.example.com>", ["a@customer.nl"]);
  it("no filter matches everything", () => expect(shouldDeliver({ name: "x", url: "u" }, e)).toBe(true));
  it("matches type, wildcard type, domain, from, to", () => {
    const f = (filter: object) => shouldDeliver({ name: "x", url: "u", filter }, e);
    expect(f({ types: ["email.bounced"] })).toBe(true);
    expect(f({ types: ["email.*"] })).toBe(true);
    expect(f({ types: ["email.delivered"] })).toBe(false);
    expect(f({ domains: ["shop.example.com"] })).toBe(true);
    expect(f({ domains: ["other.com"] })).toBe(false);
    expect(f({ from: ["*@shop.example.com"] })).toBe(true);
    expect(f({ to: ["*@customer.nl"] })).toBe(true);
    expect(f({ to: ["*@customer.com"] })).toBe(false);
    expect(f({ types: ["email.*"], domains: ["other.com"] })).toBe(false);
  });
  it("exclude and disabled", () => {
    expect(shouldDeliver({ name: "x", url: "u", exclude: { types: ["email.bounced"] } }, e)).toBe(false);
    expect(shouldDeliver({ name: "x", url: "u", disabled: true }, e)).toBe(false);
  });
  it("handles several from addresses", () => {
    const d = ev("email.sent", "A <a@x.com>, B <b@y.com>", "c@d.com");
    expect(shouldDeliver({ name: "x", url: "u", filter: { domains: ["y.com"] } }, d)).toBe(true);
  });
  it("reads data.object when object is absent", () => {
    const d = { type: "email.sent", data: { object: { from: "a@x.com", to: "b@y.com" } } };
    expect(shouldDeliver({ name: "x", url: "u", filter: { domains: ["x.com"], to: ["b@y.com"] } }, d)).toBe(true);
  });
});

describe("config", () => {
  it("validates", () => {
    expect(parseDestinations(undefined)).toEqual([]);
    expect(() => parseDestinations("{}")).toThrow();
    expect(() => parseDestinations('[{"name":"a","url":"http://evil.com"}]')).toThrow();
    expect(() => parseDestinations('[{"name":"a","url":"http://localhost.evil.com"}]')).toThrow();
    expect(() => parseDestinations('[{"name":"a","url":"https://x.com","filter":{"types":"email.*"}}]')).toThrow();
    expect(() => parseDestinations('[{"name":"a","url":"https://x.com","exclude":{}}]')).toThrow();
    expect(parseDestinations('[{"name":"a","url":"https://x.com"}]')).toHaveLength(1);
  });
});

describe("deliver", () => {
  it("posts headers and re-signs with the destination secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const ok = await deliver({ name: "d", url: "https://d.test", secret: "s3", headers: { authorization: "Bearer t" } }, [ev("email.sent", "a@b.com", "c@d.com")]);
    expect(ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBe("Bearer t");
    expect(init.headers["x-emailit-signature"]).toBe(await sign("s3", init.headers["x-emailit-timestamp"], init.body));
  });
  it("retries 5xx then succeeds, gives up on 4xx", async () => {
    const m = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", m);
    expect(await deliver({ name: "d", url: "https://d.test" }, [{}], 1)).toBe(true);
    expect(m).toHaveBeenCalledTimes(2);
    const m2 = vi.fn().mockResolvedValue(new Response("", { status: 400 }));
    vi.stubGlobal("fetch", m2);
    expect(await deliver({ name: "d", url: "https://d.test" }, [{}], 1)).toBe(false);
    expect(m2).toHaveBeenCalledTimes(1);
  });
});

describe("worker", () => {
  const dests = JSON.stringify([
    { name: "bounces", url: "https://bounce.test", filter: { types: ["email.bounced"] } },
    { name: "all", url: "https://all.test" },
  ]);
  const run = async (body: string, headers: Record<string, string>, env: object) => {
    const waits: Promise<unknown>[] = [];
    const res = await worker.fetch(new Request("https://w.test", { method: "POST", body, headers }), env as never, { waitUntil: (p: Promise<unknown>) => waits.push(p) } as never);
    await Promise.all(waits);
    return res;
  };

  it("401 on bad signature, no fan-out", async () => {
    const m = vi.fn();
    vi.stubGlobal("fetch", m);
    const res = await run(BODY, { "x-emailit-signature": "bad", "x-emailit-timestamp": TS }, { EMAILIT_SIGNING_SECRET: SECRET, DESTINATIONS: dests });
    expect(res.status).toBe(401);
    expect(m).not.toHaveBeenCalled();
  });

  it("fans out only matching events per destination", async () => {
    const m = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", m);
    const body = JSON.stringify([ev("email.bounced", "a@x.com", "b@y.com"), ev("email.delivered", "a@x.com", "b@y.com")]);
    const res = await run(body, {}, { DESTINATIONS: dests, ALLOW_UNSIGNED: "true" });
    expect(res.status).toBe(200);
    const sent = Object.fromEntries(m.mock.calls.map(([url, init]) => [url, JSON.parse(init.body).length]));
    expect(sent).toEqual({ "https://bounce.test": 1, "https://all.test": 2 });
  });

  it("503 when no secret configured, unless ALLOW_UNSIGNED", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));
    expect((await run("[]", {}, { DESTINATIONS: dests })).status).toBe(503);
    expect((await run("[]", {}, { DESTINATIONS: dests, ALLOW_UNSIGNED: "true" })).status).toBe(200);
  });

  it("400 on invalid config", async () => {
    expect((await run("[]", {}, { DESTINATIONS: "nope", ALLOW_UNSIGNED: "true" })).status).toBe(400);
  });
});
