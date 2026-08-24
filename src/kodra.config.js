function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const KODRA_CONFIG = deepFreeze({
  schemaVersion: 1,
  product: {
    name: "Kodra",
    minimumWindow: { width: 480, height: 360 },
  },
  preferences: {
    motion: "cli-ui-motion-preference",
    composerMode: "kodra-composer-mode",
    diffView: "kodra-diff-view",
  },
  defaults: {
    motion: "full",
    composerMode: "auto",
    diffView: "unified",
  },
  ui: {
    statusToastMs: 3200,
    followOutputThresholdPx: 48,
    transcriptMountBudget: 6,
  },
  features: {
    customThemes: true,
    inlineAttachments: true,
    transcriptVirtualization: true,
    composerPanels: true,
  },
});

export function publicConfigSnapshot(config = KODRA_CONFIG) {
  return JSON.parse(JSON.stringify(config));
}
