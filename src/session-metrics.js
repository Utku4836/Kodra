import { attachmentTokenEstimate } from "./attachment-support.js";

export function contextLimitOf(config) {
  const value = config?.contextLimit ? Number(config.contextLimit) : 0;
  return value >= 8_000 && value <= 4_000_000 ? value : 131_072;
}

export function contextRatioOf(config) {
  const ratio = config?.contextRatio !== undefined ? Number(config.contextRatio) : Number.NaN;
  return Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.8;
}

export function outputReserveOf(config) {
  const limit = contextLimitOf(config);
  const configured = Number(config?.maxOutputTokens || 0);
  const reserve = configured > 0 ? configured : 8_192;
  return Math.min(Math.floor(limit * 0.25), Math.max(2_048, reserve));
}

export function usableContextLimit(config) {
  return Math.max(4_096, contextLimitOf(config) - outputReserveOf(config));
}

export function compactThresholdFor(config) {
  return Math.floor(usableContextLimit(config) * contextRatioOf(config));
}

export function estimateTokens(history = []) {
  let total = 0;
  for (const message of history) {
    total += 4;
    total += Math.ceil(String(message.content || "").length / 4);
    total += attachmentTokenEstimate(message.attachments || []);
    if (message.toolCalls) total += Math.ceil(JSON.stringify(message.toolCalls).length / 4);
    if (message.toolCallId) total += Math.ceil(String(message.toolCallId).length / 4);
    if (message.reasoningContent) total += Math.ceil(String(message.reasoningContent).length / 4);
  }
  return total;
}

export function formatCompactNumber(value) {
  const number = Number(value || 0);
  return number >= 1_000 ? `${(number / 1_000).toFixed(1)}k` : String(number);
}

export function defaultSessionUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    currentContextTokens: 0,
    apiCalls: 0,
    source: "",
    costUsd: null,
    rateLimits: null,
    lastRequest: null,
  };
}

export function defaultCompactionState() {
  return {
    autoEnabled: true,
    threshold: 0.8,
    summary: "",
    compactedThrough: 0,
    count: 0,
    lastAt: null,
    lastMode: null,
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
  };
}

export function normalizeSessionIntelligence(record) {
  if (!record) return record;
  record.usage = { ...defaultSessionUsage(), ...(record.usage || {}) };
  record.compaction = { ...defaultCompactionState(), ...(record.compaction || {}) };
  record.compaction.autoEnabled = record.compaction.autoEnabled !== false;
  const threshold = Number(record.compaction.threshold);
  record.compaction.threshold = threshold >= 0.5 && threshold <= 0.95 ? threshold : 0.8;
  return record;
}

export function turnCostUsd(usage, config) {
  if (config?.inputPricePerMillion === null || config?.inputPricePerMillion === undefined
      || config?.outputPricePerMillion === null || config?.outputPricePerMillion === undefined) {
    return null;
  }
  const inputPrice = Number(config.inputPricePerMillion);
  const outputPrice = Number(config.outputPricePerMillion);
  const hasCachedPrice = config.cachedInputPricePerMillion !== null
    && config.cachedInputPricePerMillion !== undefined;
  const cachedPriceValue = Number(config.cachedInputPricePerMillion);
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) return null;
  const input = Number(usage.inputTokens || 0);
  const output = Number(usage.outputTokens || 0);
  const cached = Math.min(input, Number(usage.cachedTokens || 0));
  const uncached = Math.max(0, input - cached);
  const cachedPrice = hasCachedPrice && Number.isFinite(cachedPriceValue) ? cachedPriceValue : inputPrice;
  return ((uncached * inputPrice) + (cached * cachedPrice) + (output * outputPrice)) / 1_000_000;
}
