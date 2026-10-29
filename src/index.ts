import { attempt, deliver } from "./deliver";
import { shouldDeliver } from "./filter";
import type { Destination, EmailitEvent, Env, Job } from "./types";
import { verifyEmailit } from "./verify";

export function parseDestinations(raw: string | undefined): Destination[] {
  if (!raw) return [];
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error("DESTINATIONS must be a JSON array");
  for (const d of list) {
    if (!d || typeof d.name !== "string" || typeof d.url !== "string") throw new Error("each destination needs name and url");
    let url: URL;
    try {
      url = new URL(d.url);
    } catch {
      throw new Error(`destination ${d.name}: invalid url`);
    }
    if (url.protocol !== "https:") throw new Error(`destination ${d.name}: url must be https`);
    if (d.format !== undefined && d.format !== "batch" && d.format !== "single") {
      throw new Error(`destination ${d.name}: format must be "batch" or "single"`);
    }
    if (d.headers !== undefined && (typeof d.headers !== "object" || Object.values(d.headers).some((v) => typeof v !== "string"))) {
      throw new Error(`destination ${d.name}: headers must be an object of strings`);
    }
    for (const key of ["filter", "exclude"]) {
      const f = d[key];
      if (f === undefined) continue;
      const entries = f && typeof f === "object" ? Object.entries(f) : [];
      if (!entries.length) throw new Error(`destination ${d.name}: ${key} must be a non-empty object`);
      for (const [k, v] of entries) {
        if (!["types", "domains", "from", "to"].includes(k) || !Array.isArray(v) || v.some((x) => typeof x !== "string")) {
          throw new Error(`destination ${d.name}: ${key}.${k} must be one of types, domains, from, to, as a list of strings`);
        }
      }
    }
  }
  return list;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "GET") return new Response("emailit-fanout is running. POST Emailit webhooks here.\n");
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const raw = await request.text();

    if (!env.EMAILIT_SIGNING_SECRET && env.ALLOW_UNSIGNED !== "true") {
      return new Response("EMAILIT_SIGNING_SECRET is not set", { status: 503 });
    }
    if (env.EMAILIT_SIGNING_SECRET) {
      const ok = await verifyEmailit(
        env.EMAILIT_SIGNING_SECRET,
        raw,
        request.headers.get("x-emailit-signature"),
        request.headers.get("x-emailit-timestamp"),
      );
      if (!ok) return new Response("Invalid signature", { status: 401 });
    }

    let events: EmailitEvent[];
    let destinations: Destination[];
    try {
      const parsed = JSON.parse(raw);
      events = Array.isArray(parsed) ? parsed : [parsed];
      destinations = parseDestinations(env.DESTINATIONS);
    } catch (err) {
      console.error(`bad request or config: ${err}`);
      return new Response("Bad request or invalid DESTINATIONS config", { status: 400 });
    }

    const jobs: Job[] = destinations.flatMap((dest) => {
      const matching = events.filter((e) => shouldDeliver(dest, e));
      const groups = dest.format === "single" ? matching.map((e) => [e]) : chunk(matching);
      return groups.map((group) => ({ destination: dest.name, events: group }));
    });

    if (!env.DELIVERIES) {
      // No queue bound: answer now, deliver best effort in the background.
      const byName = new Map(destinations.map((d) => [d.name, d]));
      ctx.waitUntil(Promise.all(jobs.map((j) => deliver(byName.get(j.destination)!, j.events))));
      return Response.json({ received: events.length, jobs: jobs.length, durable: false });
    }

    // Store every delivery before answering 200. If this fails, Emailit gets a 5xx and retries the batch.
    try {
      for (const group of sendGroups(jobs)) await env.DELIVERIES.sendBatch(group.map((body) => ({ body })));
    } catch (err) {
      console.error(`enqueue failed: ${err}`);
      return new Response("Could not queue deliveries", { status: 503 });
    }
    return Response.json({ received: events.length, jobs: jobs.length, durable: true });
  },

  async queue(batch: MessageBatch<Job>, env: Env): Promise<void> {
    let destinations: Destination[] = [];
    try {
      destinations = parseDestinations(env.DESTINATIONS);
    } catch (err) {
      console.error(`invalid DESTINATIONS, retrying later: ${err}`);
      return batch.retryAll({ delaySeconds: 300 });
    }
    // Destinations run in parallel, so one slow destination does not hold up the others.
    await Promise.allSettled(
      batch.messages.map(async (msg) => {
        // Look the destination up now, so edits to DESTINATIONS apply to queued events too.
        const dest = destinations.find((d) => d.name === msg.body.destination);
        if (!dest || dest.disabled) {
          console.error(`[${msg.body.destination}] gone or disabled, dropping ${msg.body.events.length} event(s)`);
          return msg.ack();
        }
        const outcome = await attempt(dest, msg.body.events);
        if (outcome === "retry") msg.retry({ delaySeconds: backoff(msg.attempts) });
        else msg.ack();
      }),
    );
  },
};

/** 30s, 1m, 2m, 4m ... capped at 1h. */
export function backoff(attempts: number): number {
  return Math.min(3600, 30 * 2 ** (attempts - 1));
}

const MAX_MESSAGE_BYTES = 100_000;
const MAX_SEND_BYTES = 200_000;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Keeps each queue message well under the 128 KB limit. An event that is too big alone is dropped. */
export function chunk(events: EmailitEvent[], maxBytes = MAX_MESSAGE_BYTES): EmailitEvent[][] {
  const out: EmailitEvent[][] = [];
  let cur: EmailitEvent[] = [];
  let size = 0;
  for (const e of events) {
    const n = bytes(e);
    if (n > maxBytes) {
      console.error(`event ${e.event_id ?? "?"} is ${n} bytes, too large to queue, dropping`);
      continue;
    }
    if (cur.length && size + n > maxBytes) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Splits jobs into sendBatch calls of at most 100 messages and about 200 KB (the limit is 256 KB). */
export function sendGroups(jobs: Job[], maxBytes = MAX_SEND_BYTES): Job[][] {
  const out: Job[][] = [];
  let cur: Job[] = [];
  let size = 0;
  for (const j of jobs) {
    const n = bytes(j);
    if (cur.length && (cur.length >= 100 || size + n > maxBytes)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(j);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
