import type { CacheRetention } from "@oh-my-pi/pi-ai";

/** Brisk prefers the longest provider-supported cache lifetime unless explicitly overridden. */
export function resolvePromptCacheRetention(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CacheRetention {
  const configured = environment.PI_CACHE_RETENTION;
  return configured === "none" || configured === "short" || configured === "long"
    ? configured
    : "long";
}
