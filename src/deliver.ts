import { sign } from "./verify";
import type { Destination, EmailitEvent } from "./types";

const ATTEMPTS = 3;
const TIMEOUT_MS = 8_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Outcome = "ok" | "retry" | "drop";

/** One POST to a destination. "drop" means retrying will not help (3xx, most other 4xx). */
export async function attempt(dest: Destination, events: EmailitEvent[], tries = 1): Promise<Outcome> {
  const body = JSON.stringify(dest.format === "single" ? events[0] : events);
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "emailit-fanout", ...dest.headers };
  if (dest.secret) {
    const ts = String(Math.floor(Date.now() / 1000));
    headers["x-emailit-timestamp"] = ts;
    headers["x-emailit-signature"] = await sign(dest.secret, ts, body);
  }
  let outcome: Outcome;
  let detail: number | string;
  try {
    const res = await fetch(dest.url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    detail = res.status;
    // Auth and routing mistakes (401, 403, 404) are usually fixed by editing the config, so keep the event.
    outcome = res.ok ? "ok" : res.status < 500 && ![401, 403, 404, 408, 425, 429].includes(res.status) ? "drop" : "retry";
  } catch (err) {
    detail = `error: ${err}`;
    outcome = "retry";
  }
  // One JSON line per attempt, searchable in the Cloudflare dashboard (Workers, Observability).
  const line = JSON.stringify({ msg: "delivery", destination: dest.name, outcome, attempt: tries, detail, events: events.map((e) => ({ id: e.event_id, type: e.type })) });
  (outcome === "ok" ? console.log : console.error)(line);
  return outcome;
}

/** Quick in-process retries, used only when no queue is bound. */
export async function deliver(dest: Destination, events: EmailitEvent[], retryDelayMs = 500): Promise<boolean> {
  for (let n = 1; n <= ATTEMPTS; n++) {
    const outcome = await attempt(dest, events, n);
    if (outcome !== "retry") return outcome === "ok";
    if (n < ATTEMPTS) await sleep(retryDelayMs * n);
  }
  return false;
}
