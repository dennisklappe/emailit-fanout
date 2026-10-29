import { sign } from "./verify";
import type { Destination, EmailitEvent } from "./types";

const ATTEMPTS = 3;
const TIMEOUT_MS = 8_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Outcome = "ok" | "retry" | "drop";

/** One POST to a destination. "drop" means retrying will not help (3xx, most other 4xx). */
export async function attempt(dest: Destination, events: EmailitEvent[]): Promise<Outcome> {
  const body = JSON.stringify(dest.format === "single" ? events[0] : events);
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "emailit-fanout", ...dest.headers };
  if (dest.secret) {
    const ts = String(Math.floor(Date.now() / 1000));
    headers["x-emailit-timestamp"] = ts;
    headers["x-emailit-signature"] = await sign(dest.secret, ts, body);
  }
  try {
    const res = await fetch(dest.url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return "ok";
    console.error(`[${dest.name}] got ${res.status}`);
    // Auth and routing mistakes (401, 403, 404) are usually fixed by editing the config, so keep the event.
    return res.status < 500 && ![401, 403, 404, 408, 425, 429].includes(res.status) ? "drop" : "retry";
  } catch (err) {
    console.error(`[${dest.name}] failed: ${err}`);
    return "retry";
  }
}

/** Quick in-process retries, used only when no queue is bound. */
export async function deliver(dest: Destination, events: EmailitEvent[], retryDelayMs = 500): Promise<boolean> {
  for (let n = 1; n <= ATTEMPTS; n++) {
    const outcome = await attempt(dest, events);
    if (outcome !== "retry") return outcome === "ok";
    if (n < ATTEMPTS) await sleep(retryDelayMs * n);
  }
  return false;
}
