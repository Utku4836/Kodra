function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function boundedText(value, max = 240) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

export function createProviderObservation(config, reply, elapsedMs, at = Date.now()) {
  const usage = reply?.usage || {};
  return {
    provider: boundedText(config?.provider, 48),
    requestedModel: boundedText(config?.model, 180),
    responseModel: boundedText(reply?.model || config?.model, 180),
    latencyMs: Math.round(finiteNumber(elapsedMs)),
    inputTokens: Math.round(finiteNumber(usage.inputTokens)),
    outputTokens: Math.round(finiteNumber(usage.outputTokens)),
    reasoningTokens: Math.round(finiteNumber(usage.reasoningTokens)),
    cachedTokens: Math.round(finiteNumber(usage.cachedTokens)),
    totalTokens: Math.round(finiteNumber(usage.totalTokens)),
    observedAt: Math.round(finiteNumber(at, Date.now())),
  };
}

export function mergeDiagnosticReport(report, observation = null) {
  const clean = report && typeof report === "object" ? { ...report } : {};
  const sameProvider = observation?.provider && observation.provider === clean.providerId;
  clean.lastRequest = sameProvider ? { ...observation } : null;
  clean.checks = Array.isArray(clean.checks) ? clean.checks.map((entry) => ({ ...entry })) : [];
  return clean;
}

export function diagnosticStateLabel(state) {
  return ({
    healthy: "Sağlıklı",
    degraded: "Kısıtlı",
    rate_limited: "Limitli",
    offline: "Çevrimdışı",
    failed: "Hatalı",
    ready: "Hazır",
    unsupported: "Desteklenmiyor",
    skipped: "Atlandı",
    checking: "Kontrol ediliyor",
  })[state] || "Bilinmiyor";
}

export function diagnosticExport(report) {
  const source = report && typeof report === "object" ? report : {};
  const last = source.lastRequest && typeof source.lastRequest === "object"
    ? {
        provider: boundedText(source.lastRequest.provider, 48),
        requestedModel: boundedText(source.lastRequest.requestedModel, 180),
        responseModel: boundedText(source.lastRequest.responseModel, 180),
        latencyMs: Math.round(finiteNumber(source.lastRequest.latencyMs)),
        inputTokens: Math.round(finiteNumber(source.lastRequest.inputTokens)),
        outputTokens: Math.round(finiteNumber(source.lastRequest.outputTokens)),
        reasoningTokens: Math.round(finiteNumber(source.lastRequest.reasoningTokens)),
        cachedTokens: Math.round(finiteNumber(source.lastRequest.cachedTokens)),
        totalTokens: Math.round(finiteNumber(source.lastRequest.totalTokens)),
        observedAt: Math.round(finiteNumber(source.lastRequest.observedAt)),
      }
    : null;
  return {
    schemaVersion: 1,
    providerId: boundedText(source.providerId, 48),
    providerName: boundedText(source.providerName, 100),
    overall: boundedText(source.overall, 32),
    checkedAt: Math.round(finiteNumber(source.checkedAt)),
    endpoint: boundedText(source.endpoint, 220),
    protocol: boundedText(source.protocol, 64),
    requestedModel: boundedText(source.requestedModel, 180),
    responseModel: boundedText(source.responseModel, 180) || null,
    modelCount: source.modelCount === null || source.modelCount === undefined
      ? null
      : Math.round(finiteNumber(source.modelCount)),
    recommendedModel: boundedText(source.recommendedModel, 180) || null,
    deepTest: Boolean(source.deepTest),
    errorKind: boundedText(source.errorKind, 64) || null,
    requestId: boundedText(source.requestId, 128) || null,
    account: source.account && typeof source.account === "object"
      ? {
          limitUsd: source.account.limitUsd === null || source.account.limitUsd === undefined ? null : finiteNumber(source.account.limitUsd),
          remainingUsd: source.account.remainingUsd === null || source.account.remainingUsd === undefined ? null : finiteNumber(source.account.remainingUsd),
          usageUsd: source.account.usageUsd === null || source.account.usageUsd === undefined ? null : finiteNumber(source.account.usageUsd),
          resetAt: boundedText(source.account.resetAt, 100) || null,
          tier: boundedText(source.account.tier, 24) || null,
        }
      : null,
    rateLimits: source.rateLimits && typeof source.rateLimits === "object"
      ? Object.fromEntries(Object.entries(source.rateLimits).map(([key, value]) => [boundedText(key, 64), boundedText(value, 80)]))
      : null,
    checks: (Array.isArray(source.checks) ? source.checks : []).slice(0, 12).map((entry) => ({
      id: boundedText(entry.id, 64),
      title: boundedText(entry.title, 100),
      state: boundedText(entry.state, 32),
      detail: boundedText(entry.detail, 320),
      action: boundedText(entry.action, 240) || null,
      latencyMs: entry.latencyMs === null || entry.latencyMs === undefined
        ? null
        : Math.round(finiteNumber(entry.latencyMs)),
    })),
    lastRequest: last,
  };
}
