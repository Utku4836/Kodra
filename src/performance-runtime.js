export const RUNTIME_PERFORMANCE_BUDGETS = Object.freeze({
  modelCacheFreshMs: 5 * 60 * 1000,
  modelCacheStaleMs: 60 * 60 * 1000,
  longSessionItems: 500,
  maxFrameJobsPerScheduler: 1,
});

export const PUBLIC_MODEL_CACHE_KEY = "cli-ui-public-model-catalog-v1";

export function publicModelCatalog(items, maxItems = 1200) {
  const source = Array.isArray(items) ? items : [];
  return source.slice(0, Math.max(1, maxItems)).map((model) => ({
    id: String(model?.id || "").slice(0, 220),
    displayName: String(model?.displayName || "").slice(0, 220),
    providerId: String(model?.providerId || "").slice(0, 64),
    providerName: String(model?.providerName || "").slice(0, 100),
    contextWindow: Number.isFinite(Number(model?.contextWindow)) ? Number(model.contextWindow) : null,
    maxOutputTokens: Number.isFinite(Number(model?.maxOutputTokens)) ? Number(model.maxOutputTokens) : null,
    inputPricePerMillion: Number.isFinite(Number(model?.inputPricePerMillion)) ? Number(model.inputPricePerMillion) : null,
    outputPricePerMillion: Number.isFinite(Number(model?.outputPricePerMillion)) ? Number(model.outputPricePerMillion) : null,
    cachedInputPricePerMillion: Number.isFinite(Number(model?.cachedInputPricePerMillion)) ? Number(model.cachedInputPricePerMillion) : null,
    supportsTools: typeof model?.supportsTools === "boolean" ? model.supportsTools : null,
    supportsReasoning: typeof model?.supportsReasoning === "boolean" ? model.supportsReasoning : null,
    supportsVision: typeof model?.supportsVision === "boolean" ? model.supportsVision : null,
    status: String(model?.status || "").slice(0, 32),
    recommended: Boolean(model?.recommended),
  })).filter((model) => model.id && model.providerId);
}

export function parsePublicModelCache(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const items = publicModelCatalog(parsed?.items);
    if (!items.length) return null;
    return {
      items,
      expiresAt: Number(parsed.expiresAt || 0),
      staleUntil: Number(parsed.staleUntil || 0),
    };
  } catch (_) {
    return null;
  }
}

export function createFrameCoalescer(callback, options = {}) {
  const requestFrame = options.requestFrame || globalThis.requestAnimationFrame?.bind(globalThis);
  const cancelFrame = options.cancelFrame || globalThis.cancelAnimationFrame?.bind(globalThis);
  if (typeof requestFrame !== "function") throw new TypeError("requestAnimationFrame is required");
  let frame = 0;
  let latestArgs = [];

  return {
    schedule(...args) {
      latestArgs = args;
      if (frame) return frame;
      frame = requestFrame(() => {
        frame = 0;
        const argsForFrame = latestArgs;
        latestArgs = [];
        callback(...argsForFrame);
      });
      return frame;
    },
    cancel() {
      if (frame && typeof cancelFrame === "function") cancelFrame(frame);
      frame = 0;
      latestArgs = [];
    },
    get pending() {
      return Boolean(frame);
    },
  };
}

export function modelCacheState(cache, now = Date.now()) {
  if (!cache?.items?.length) return "miss";
  if (cache.expiresAt > now) return "fresh";
  if ((cache.staleUntil || cache.expiresAt) > now) return "stale";
  return "expired";
}
