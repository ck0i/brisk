import type { Api, Model } from "@oh-my-pi/pi-catalog";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";

import type { NormalizedProviderError, ProviderEvent } from "../core/events.ts";
import type { ModelTransport } from "./transport.ts";
import type { ProviderRequest } from "./types.ts";

type Reasoning = Effort | "off" | undefined;

/*++

OpenCode Go and Command Code resell the same open-weight lanes, so a model both
of them serve is one model with two quotas. Their ids only differ by vendor
namespace and case (`kimi-k2.7-code` vs `moonshotai/Kimi-K2.7-Code`), so the
bare lowercase id is the identity. I kept the match exact on purpose: the
catalog's looser reference matcher strips markers like `:free` and would merge
SKUs that are billed differently.

--*/
const POOLED_PROVIDERS: ReadonlySet<string> = new Set(["opencode-go", "commandcode"]);

const RATE_LIMIT_COOLDOWN_MS = 60_000;
const NETWORK_COOLDOWN_MS = 15_000;
const AUTH_COOLDOWN_MS = 10 * 60_000;

export function modelPoolKey(provider: string, id: string): string | undefined {
  if (!POOLED_PROVIDERS.has(provider)) return undefined;
  return id.slice(id.lastIndexOf("/") + 1).toLowerCase();
}

//
// one of these is shared by every transport a ProviderService hands out, so a
// plan the main loop just saw fail is also skipped by subagents and advisors.
//
export class ModelPool {
  private readonly cooling = new Map<string, number>();
  private readonly live = new Map<string, number>();

  //
  // random start so a fresh process doesn't always open its first session on the same plan.
  //
  constructor(private rotation = Math.floor(Math.random() * 1024)) {}

  coolingUntil(provider: string): number {
    return this.cooling.get(provider) ?? 0;
  }

  recordFailure(provider: string, error: NormalizedProviderError): void {
    const duration = cooldownFor(error);
    if (duration === undefined) return;
    this.cooling.set(provider, Math.max(this.coolingUntil(provider), Date.now() + duration));
  }

  reset(): void {
    this.cooling.clear();
  }

  /*++

  New conversations go to the healthy plan carrying the fewest live ones, and
  the rotation only breaks ties. A plain round robin looked fine until subagent
  advisors were pooled too: child, advisor, child, advisor hit the same parity
  every time, so every child landed on one plan and every advisor on the other.

  --*/
  assign(members: readonly ModelTransport[]): ModelTransport {
    const now = Date.now();
    const healthy = members.filter((member) => this.coolingUntil(member.model.provider) <= now);
    const candidates = healthy.length > 0 ? healthy : members;
    const load = (member: ModelTransport): number => this.live.get(member.model.provider) ?? 0;
    const lightest = Math.min(...candidates.map(load));
    const tied = candidates.filter((member) => load(member) === lightest);
    const member = tied.length === 1 ? tied[0] : tied[this.rotation++ % tied.length];
    if (!member) throw new RangeError("A model pool needs at least one member");
    this.claim(member);
    return member;
  }

  claim(member: ModelTransport): void {
    const provider = member.model.provider;
    this.live.set(provider, (this.live.get(provider) ?? 0) + 1);
  }

  release(member: ModelTransport): void {
    const provider = member.model.provider;
    const remaining = (this.live.get(provider) ?? 0) - 1;
    if (remaining > 0) this.live.set(provider, remaining);
    else this.live.delete(provider);
  }
}

export interface PooledTransportOptions {
  //
  // the selected model comes first; the rest are its equivalents on the other plans.
  //
  readonly members: readonly ModelTransport[];
  readonly pool: ModelPool;
  readonly sessionId?: string;
  readonly memberReasoning: (model: Model<Api>, reasoning: Reasoning) => Reasoning;
}

/*++

Routes one logical model across equivalent plans. I pin each conversation to a
single plan instead of alternating per request: both gateways bill prompt-cache
misses at the full input rate, so bouncing between them would burn more quota
than it saves. The split comes from balancing new conversations (sessions,
subagents, advisors) across plans, and from failing over when a plan is limited.

A member that fails before streaming any output is invisible to the agent loop.
its events are held back and the request is replayed on the next member. once
output has started the error passes through untouched, and the cooldown it
recorded steers the loop's own retry onto another plan.

--*/
export class PooledTransport implements ModelTransport {
  private readonly primary: ModelTransport;
  private readonly members: readonly ModelTransport[];
  private readonly pool: ModelPool;
  private readonly memberReasoning: PooledTransportOptions["memberReasoning"];
  private sessionId: string | undefined;
  private current: ModelTransport;
  private closed = false;

  constructor(options: PooledTransportOptions) {
    const [primary] = options.members;
    if (!primary || options.members.length < 2) {
      throw new RangeError("A pooled transport needs at least two members");
    }
    this.primary = primary;
    this.members = options.members;
    this.pool = options.pool;
    this.memberReasoning = options.memberReasoning;
    this.sessionId = options.sessionId;
    this.current = this.pool.assign(this.members);
  }

  get model(): Model<Api> {
    return this.primary.model;
  }

  setModel(): void {
    throw new Error("A pooled transport is rebuilt, not retargeted, when its model changes");
  }

  setReasoning(reasoning: Reasoning): void {
    for (const member of this.members) {
      member.setReasoning(
        member === this.primary ? reasoning : this.memberReasoning(member.model, reasoning),
      );
    }
  }

  setSessionId(sessionId: string | undefined): void {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    for (const member of this.members) member.setSessionId(sessionId);
    this.pool.release(this.current);
    this.current = this.pool.assign(this.members);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pool.release(this.current);
    for (const member of this.members) member.close();
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const tried = new Set<ModelTransport>();
    let failed: readonly ProviderEvent[] = [];
    for (let member = this.next(request, tried); member; member = this.next(request, tried)) {
      tried.add(member);
      const held: ProviderEvent[] = [];
      let committed = false;
      let error: NormalizedProviderError | undefined;
      for await (const event of member.stream(request)) {
        if (event.type === "error") {
          error = event.error;
          this.pool.recordFailure(member.model.provider, event.error);
        }
        if (committed) {
          yield event;
          continue;
        }
        held.push(event);
        if (error) break;
        if (event.type === "response_start" || event.type === "usage") continue;
        committed = true;
        this.moveTo(member);
        yield* held;
      }
      if (committed) return;
      if (!error) {
        this.moveTo(member);
        yield* held;
        return;
      }
      failed = held;
      if (request.signal.aborted || error.kind === "aborted") break;
    }
    yield* failed;
  }

  private moveTo(member: ModelTransport): void {
    if (member === this.current) return;
    if (!this.closed) {
      this.pool.release(this.current);
      this.pool.claim(member);
    }
    this.current = member;
  }

  private next(
    request: ProviderRequest,
    tried: ReadonlySet<ModelTransport>,
  ): ModelTransport | undefined {
    //
    // a text-only plan would silently drop the conversation's images, so it never takes over one.
    //
    const seesImages = this.members.filter((member) => member.model.input.includes("image"));
    const eligible = seesImages.length > 0 && hasImages(request) ? seesImages : this.members;
    const now = Date.now();
    const wait = (member: ModelTransport): number =>
      Math.max(0, this.pool.coolingUntil(member.model.provider) - now);
    return eligible
      .filter((member) => !tried.has(member))
      .sort(
        (left, right) =>
          wait(left) - wait(right) ||
          Number(right === this.current) - Number(left === this.current),
      )[0];
  }
}

function hasImages(request: ProviderRequest): boolean {
  return request.messages.some(
    (message) => message.role === "user" && (message.images?.length ?? 0) > 0,
  );
}

function cooldownFor(error: NormalizedProviderError): number | undefined {
  switch (error.kind) {
    case "rate_limit":
      return error.retryAfter ?? RATE_LIMIT_COOLDOWN_MS;
    case "network":
      return error.retryAfter ?? NETWORK_COOLDOWN_MS;
    case "auth":
      return AUTH_COOLDOWN_MS;
    default:
      return undefined;
  }
}
