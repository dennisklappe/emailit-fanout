import type { Destination, EmailitEvent, Filter } from "./types";

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(patterns: string[], values: string[]): boolean {
  const res = patterns.map(globToRegExp);
  return values.some((v) => res.some((r) => r.test(v.toLowerCase())));
}

/** Pulls bare addresses out of "Name <a@b.com>, c@d.com". */
function addresses(value: string): string[] {
  const bracketed = [...value.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  return bracketed.length ? bracketed : value.split(",").map((v) => v.trim()).filter(Boolean);
}

function asList(value: unknown): string[] {
  if (typeof value === "string") return addresses(value);
  if (Array.isArray(value)) return value.flatMap(asList);
  return [];
}

export function describeEvent(event: EmailitEvent) {
  const obj = event.object ?? event.data?.object ?? {};
  const from = asList(obj.from);
  return {
    type: typeof event.type === "string" ? event.type : "",
    from,
    domains: from.map((f) => f.split("@")[1] ?? "").filter(Boolean),
    to: asList(obj.to),
  };
}

function matchesFilter(filter: Filter, event: EmailitEvent): boolean {
  const d = describeEvent(event);
  if (filter.types && !matchesAny(filter.types, [d.type])) return false;
  if (filter.domains && !matchesAny(filter.domains, d.domains)) return false;
  if (filter.from && !matchesAny(filter.from, d.from)) return false;
  if (filter.to && !matchesAny(filter.to, d.to)) return false;
  return true;
}

export function shouldDeliver(dest: Destination, event: EmailitEvent): boolean {
  if (dest.disabled) return false;
  if (dest.filter && !matchesFilter(dest.filter, event)) return false;
  if (dest.exclude && matchesFilter(dest.exclude, event)) return false;
  return true;
}
