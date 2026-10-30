import { afterEach, describe, expect, it, vi } from "vitest";
import { attempt, deliver } from "../src/deliver";
import { shouldDeliver } from "../src/filter";
import worker, { backoff, chunk, parseDestinations, sendGroups } from "../src/index";
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

describe("durable queue", () => {
  const dests = JSON.stringify([
    { name: "bounces", url: "https://bounce.test", filter: { types: ["email.bounced"] } },
    { name: "all", url: "https://all.test" },
  ]);
  const post = (env: object, body: string) =>
    worker.fetch(new Request("https://w.test", { method: "POST", body }), { ALLOW_UNSIGNED: "true", DESTINATIONS: dests, ...env } as never, { waitUntil() {} } as never);

  it("enqueues one job per matching destination before answering 200, and does not fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const body = JSON.stringify([ev("email.bounced", "a@x.com", "b@y.com"), ev("email.delivered", "a@x.com", "b@y.com")]);
    const res = await post({ DELIVERIES: { sendBatch } }, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ jobs: 2, durable: true });
    const jobs = sendBatch.mock.calls[0][0].map((m: { body: { destination: string; events: unknown[] } }) => [m.body.destination, m.body.events.length]);
    expect(jobs).toEqual([["bounces", 1], ["all", 2]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 when the queue is unavailable so Emailit retries", async () => {
    const sendBatch = vi.fn().mockRejectedValue(new Error("down"));
    expect((await post({ DELIVERIES: { sendBatch } }, JSON.stringify([ev("email.sent", "a@x.com", "b@y.com")]))).status).toBe(503);
  });

  const msg = (destination: string, attempts = 1) => ({ body: { destination, events: [{}] }, attempts, ack: vi.fn(), retry: vi.fn() });
  const consume = (messages: ReturnType<typeof msg>[], env: object = { DESTINATIONS: dests }) =>
    worker.queue({ messages, retryAll: vi.fn() } as never, env as never);

  it("acks on success, retries with backoff on 5xx, drops on 4xx, acks unknown destinations", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response("", { status: url.includes("all") ? 200 : url.includes("bounce") ? 503 : 400 })));
    const [ok, bad, gone] = [msg("all"), msg("bounces", 3), msg("deleted")];
    await consume([ok, bad, gone]);
    expect(ok.ack).toHaveBeenCalled();
    expect(bad.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(bad.ack).not.toHaveBeenCalled();
    expect(gone.ack).toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 400 })));
    const rejected = msg("all");
    await consume([rejected]);
    expect(rejected.ack).toHaveBeenCalled();
  });

  it("backoff grows and caps, chunk splits by size", () => {
    expect([1, 2, 3, 20].map(backoff)).toEqual([30, 60, 120, 3600]);
    expect(chunk([{ a: "x".repeat(60) }, { a: "x".repeat(60) }, { a: "x".repeat(60) }], 100).map((c) => c.length)).toEqual([1, 1, 1]);
    expect(chunk([{}, {}, {}]).map((c) => c.length)).toEqual([3]);
  });
});

describe("hardening", () => {
  it("single format posts one bare object per event, and one job per event", async () => {
    const m = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", m);
    expect(await deliver({ name: "b", url: "https://b.test", format: "single" }, [{ event_id: "e1", type: "email.clicked" }])).toBe(true);
    expect(JSON.parse(m.mock.calls[0][1].body)).toEqual({ event_id: "e1", type: "email.clicked" });
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const dests = JSON.stringify([{ name: "b", url: "https://b.test", format: "single" }]);
    const body = JSON.stringify([ev("email.sent", "a@x.com", "b@y.com"), ev("email.loaded", "a@x.com", "b@y.com")]);
    await worker.fetch(new Request("https://w.test", { method: "POST", body }), { ALLOW_UNSIGNED: "true", DESTINATIONS: dests, DELIVERIES: { sendBatch } } as never, { waitUntil() {} } as never);
    expect(sendBatch.mock.calls[0][0].map((x: { body: { events: unknown[] } }) => x.body.events.length)).toEqual([1, 1]);
    expect(() => parseDestinations('[{"name":"a","url":"https://x.com","format":"xml"}]')).toThrow();
  });

  it("retries 401, 403 and 404, drops other 4xx", async () => {
    for (const [status, expected] of [[401, "retry"], [403, "retry"], [404, "retry"], [400, "drop"], [410, "drop"]] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status })));
      expect(await attempt({ name: "d", url: "https://d.test" }, [{}])).toBe(expected);
    }
  });

  it("measures bytes, drops oversized events and splits sendBatch by size and count", () => {
    expect(chunk([{ a: "\u20ac".repeat(40) }, { a: "\u20ac".repeat(40) }], 200).map((c) => c.length)).toEqual([1, 1]);
    expect(chunk([{ a: "x".repeat(500) }, { a: "y" }], 100)).toEqual([[{ a: "y" }]]);
    const job = (n: number) => ({ destination: "d", events: [{ a: "x".repeat(n) }] });
    expect(sendGroups([job(100), job(100), job(100)], 400).map((g) => g.length)).toEqual([2, 1]);
    expect(sendGroups(Array.from({ length: 250 }, () => job(1))).map((g) => g.length)).toEqual([100, 100, 50]);
  });

  it("one failing job does not stop the others in a queue batch", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("bad") ? Promise.reject(new Error("x")) : new Response("ok"))));
    const dests = JSON.stringify([{ name: "bad", url: "https://bad.test" }, { name: "good", url: "https://good.test" }]);
    const mk = (destination: string) => ({ body: { destination, events: [{}] }, attempts: 1, ack: vi.fn(), retry: vi.fn() });
    const [a, b] = [mk("bad"), mk("good")];
    await worker.queue({ messages: [a, b], retryAll: vi.fn() } as never, { DESTINATIONS: dests } as never);
    expect(a.retry).toHaveBeenCalled();
    expect(b.ack).toHaveBeenCalled();
  });
});

describe("logging", () => {
  it("logs one JSON line per delivery attempt and per queued request", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));
    await attempt({ name: "d", url: "https://d.test" }, [{ event_id: "e1", type: "email.sent" }], 2);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ msg: "delivery", destination: "d", outcome: "ok", attempt: 2, detail: 200, events: [{ id: "e1", type: "email.sent" }] });
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    await worker.fetch(new Request("https://w.test", { method: "POST", body: JSON.stringify([ev("email.sent", "a@x.com", "b@y.com")]) }), { ALLOW_UNSIGNED: "true", DESTINATIONS: '[{"name":"d","url":"https://d.test"}]', DELIVERIES: { sendBatch } } as never, { waitUntil() {} } as never);
    expect(JSON.parse(log.mock.calls[1][0])).toMatchObject({ msg: "queued", jobs: ["d"] });
    log.mockRestore();
  });
});

describe("event shapes", () => {
  it("reads sender and recipient of opens and clicks from object.email", () => {
    const loaded = { type: "email.loaded", object: { email: { mail_from: "Shop <hi@shop.example.com>", rcpt_to: "a@customer.nl" } } };
    const f = (filter: object) => shouldDeliver({ name: "x", url: "u", filter }, loaded);
    expect(f({ domains: ["shop.example.com"] })).toBe(true);
    expect(f({ from: ["*@shop.example.com"], to: ["*@customer.nl"] })).toBe(true);
    expect(f({ domains: ["other.com"] })).toBe(false);
  });
});
