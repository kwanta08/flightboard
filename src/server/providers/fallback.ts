// 位置の提供元のフォールバック（AC-A4・AC-A5）。
// 優先順に試し、失敗した提供元は一定時間「後回し」、HTTP 429 の提供元は待ち時間が過ぎるまで試さない。
import { rateLimitWaitMs, UpstreamError } from "./provider.ts";
import type { PositionFetchResult, PositionProvider, PositionSource } from "./provider.ts";

export type FallbackOptions = {
  /** 現在時刻（ms） */
  now: () => number;
  /** 失敗した提供元を後回しにする時間（既定 60 秒） */
  failureCooldownMs?: number;
  /** 429 で待ち秒数が無いときに試さない時間（既定 60 秒） */
  defaultRateLimitMs?: number;
  /** 429 で試さない時間の上限（既定 86400 秒） */
  maxRateLimitMs?: number;
};

/** `PositionFetchResult` の別名（互換のため残す） */
export type FallbackResult = PositionFetchResult;

/** `PositionSource` の別名（互換のため残す） */
export type FallbackPositionProvider = PositionSource;

export const DEFAULT_FAILURE_COOLDOWN_MS = 60_000;
export const DEFAULT_RATE_LIMIT_MS = 60_000;
export const MAX_RATE_LIMIT_MS = 86_400_000;

type ProviderState = {
  provider: PositionProvider;
  /** この時刻（ms）より前は後回し */
  deferredUntil?: number;
  /** この時刻（ms）より前は試さない */
  rateLimitedUntil?: number;
};

export function createFallbackProvider(
  providers: readonly PositionProvider[],
  options: FallbackOptions,
): PositionSource {
  if (providers.length === 0) throw new Error("createFallbackProvider: providers must not be empty");

  const { now } = options;
  const failureCooldownMs = options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;
  const defaultRateLimitMs = options.defaultRateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
  const maxRateLimitMs = options.maxRateLimitMs ?? MAX_RATE_LIMIT_MS;

  const states: ProviderState[] = providers.map((provider) => ({ provider }));

  /** レート制限中を除き、後回しでない提供元 → 後回しの提供元の順（それぞれ優先順） */
  function attemptOrder(at: number): ProviderState[] {
    const available = states.filter((s) => !isActive(s.rateLimitedUntil, at));
    return [
      ...available.filter((s) => !isActive(s.deferredUntil, at)),
      ...available.filter((s) => isActive(s.deferredUntil, at)),
    ];
  }

  function recordFailure(state: ProviderState, error: unknown, at: number): void {
    if (error instanceof UpstreamError && error.status === 429) {
      state.rateLimitedUntil =
        at + rateLimitWaitMs(error.retryAfterSec, { defaultMs: defaultRateLimitMs, maxMs: maxRateLimitMs });
    } else {
      state.deferredUntil = at + failureCooldownMs;
    }
  }

  return {
    async fetchNearby(q) {
      const order = attemptOrder(now());
      if (order.length === 0) {
        const earliest = Math.min(...states.map((s) => s.rateLimitedUntil ?? Number.POSITIVE_INFINITY));
        throw new UpstreamError(
          `all position providers are rate limited; the earliest can be retried at ${new Date(earliest).toISOString()}`,
        );
      }

      let lastError: unknown;
      for (const state of order) {
        try {
          const flights = await state.provider.fetchNearby(q);
          delete state.deferredUntil;
          delete state.rateLimitedUntil;
          return { flights, source: state.provider.id };
        } catch (error) {
          recordFailure(state, error, now());
          lastError = error;
        }
      }

      if (lastError instanceof UpstreamError) throw lastError;
      throw new UpstreamError("all position providers failed", { cause: lastError });
    },
  };
}

function isActive(until: number | undefined, at: number): boolean {
  return until !== undefined && at < until;
}
