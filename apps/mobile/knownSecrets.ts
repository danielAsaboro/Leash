export type KnownSecret = { name: string; label: string; hint: string };

export const KNOWN_SECRETS: KnownSecret[] = [
  { name: "LEASH_HA_URL", label: "Home Assistant URL", hint: "e.g. http://homeassistant.local:8123" },
  { name: "LEASH_HA_TOKEN", label: "Home Assistant token", hint: "Long-lived access token" },
  { name: "LEASH_SEARXNG_URL", label: "SearXNG URL", hint: "Self-hosted meta-search; blank = DuckDuckGo" },
];
