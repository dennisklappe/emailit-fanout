import { deliver } from "./deliver";
import { shouldDeliver } from "./filter";
import type { Destination, EmailitEvent, Env } from "./types";
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

    const jobs = destinations.flatMap((dest) => {
      const matching = events.filter((e) => shouldDeliver(dest, e));
      return matching.length ? [deliver(dest, matching)] : [];
    });
    // Answer Emailit right away; delivery (with retries) continues in the background.
    ctx.waitUntil(Promise.all(jobs));
    return Response.json({ received: events.length, destinations: jobs.length });
  },
};
