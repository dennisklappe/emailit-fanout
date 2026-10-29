import { sign } from "./verify";
import type { Destination, EmailitEvent } from "./types";

const ATTEMPTS = 3;
const TIMEOUT_MS = 8_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function deliver(dest: Destination, events: EmailitEvent[], retryDelayMs = 500): Promise<boolean> {
  const body = JSON.stringify(events);
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "emailit-fanout", ...dest.headers };
  if (dest.secret) {
    const ts = String(Math.floor(Date.now() / 1000));
    headers["x-emailit-timestamp"] = ts;
    headers["x-emailit-signature"] = await sign(dest.secret, ts, body);
  }
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(dest.url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return true;
      // 3xx and 4xx will not get better by retrying (except 408/429)
      if (res.status < 500 && res.status !== 408 && res.status !== 429) {
        console.error(`[${dest.name}] rejected with ${res.status}`);
        return false;
      }
      console.error(`[${dest.name}] attempt ${attempt} got ${res.status}`);
    } catch (err) {
      console.error(`[${dest.name}] attempt ${attempt} failed: ${err}`);
    }
    if (attempt < ATTEMPTS) await sleep(retryDelayMs * attempt);
  }
  return false;
}
