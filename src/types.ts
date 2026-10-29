export interface Env {
  /** Emailit webhook secret (whsec_...). Incoming requests are verified with it. */
  EMAILIT_SIGNING_SECRET?: string;
  /** Set to "true" to accept unsigned requests (not recommended). */
  ALLOW_UNSIGNED?: string;
  /** JSON array of Destination. */
  DESTINATIONS?: string;
}

export interface Filter {
  /** Event types, e.g. "email.bounced" or "email.*". */
  types?: string[];
  /** Sending domain, taken from the "from" address, e.g. "example.com". */
  domains?: string[];
  /** Sender address, e.g. "*@example.com". */
  from?: string[];
  /** Recipient address, e.g. "*@customer.com". */
  to?: string[];
}

export interface Destination {
  name: string;
  url: string;
  /** Extra request headers, e.g. an Authorization header. */
  headers?: Record<string, string>;
  /** If set, the forwarded body is re-signed with this secret (same scheme as Emailit). */
  secret?: string;
  /** Event must match this filter. Omitted means everything. */
  filter?: Filter;
  /** Event must NOT match this filter. */
  exclude?: Filter;
  disabled?: boolean;
}

export interface EmailitEvent {
  event_id?: string;
  type?: string;
  object?: Record<string, unknown>;
  data?: { object?: Record<string, unknown> };
  [key: string]: unknown;
}
