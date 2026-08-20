import { renderMarkdownInto } from "./markdown-ui.js";
import { createResponseMotionController } from "./response-motion.js";
import {
  createProviderObservation,
  diagnosticExport,
  diagnosticStateLabel,
  mergeDiagnosticReport,
} from "./provider-diagnostics.js";
import {
  RUNTIME_PERFORMANCE_BUDGETS,
  PUBLIC_MODEL_CACHE_KEY,
  createFrameCoalescer,
  modelCacheState,
  parsePublicModelCache,
  publicModelCatalog,
} from "./performance-runtime.js";
import {
  UI_MOTION,
  animateElementGroup,
  createMotionRuntime,
  createSelectionController,
  createSelectionInputController,
  createVisibilityController,
  resolveMotionPreference,
  sampleRefreshRate,
} from "./ui-motion.js";

const SYSTEM_REDUCED_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false;
const MOTION_PREFERENCE_KEY = "cli-ui-motion-preference";
const storedMotionPreference = localStorage.getItem(MOTION_PREFERENCE_KEY);
const motionProfile = resolveMotionPreference(SYSTEM_REDUCED_MOTION, storedMotionPreference, "full");
const appMotionPreference = motionProfile.preference;
if (!storedMotionPreference) localStorage.setItem(MOTION_PREFERENCE_KEY, appMotionPreference);
const resolvedReducedMotion = motionProfile.reduced;
document.documentElement.dataset.motionPreference = resolvedReducedMotion ? "reduced" : "full";
document.documentElement.dataset.systemReducedMotion = String(SYSTEM_REDUCED_MOTION);
const uiMotion = createMotionRuntime({ reducedMotion: () => resolvedReducedMotion });
void sampleRefreshRate().then((sample) => {
  if (!sample) return;
  document.documentElement.dataset.refreshHz = String(sample.hz);
  document.documentElement.style.setProperty("--measured-frame-budget", `${sample.frameBudgetMs}ms`);
});


const errOverlay = document.getElementById("err-overlay");
const statusToast = document.getElementById("status-toast");
const connectionState = document.getElementById("connection-state");
let errTimer = null;
let statusTimer = null;
let statusToastGeneration = 0;
let connectionOnline = navigator.onLine !== false;

function isNetworkFailure(error) {
  const message = String(error || "").toLowerCase();
  return ["bağlantı hatası", "connection", "network", "internet", "dns", "offline", "çevrimdışı"]
    .some((part) => message.includes(part));
}

function setConnectionOnline(online) {
  const connected = Boolean(online);
  connectionOnline = connected;
  document.documentElement.dataset.network = connected ? "online" : "offline";
  if (connectionState) connectionState.hidden = connected;
}

setConnectionOnline(connectionOnline);
window.addEventListener("online", () => setConnectionOnline(true));
window.addEventListener("offline", () => setConnectionOnline(false));

function showErrorOverlay(msg) {
  if (!errOverlay) return;
  errOverlay.textContent = "ERROR: " + msg;
  errOverlay.style.display = "block";
  clearTimeout(errTimer);
  errTimer = setTimeout(() => {
    errOverlay.style.display = "none";
  }, 8000);
}

async function hideStatusToast(generation) {
  if (!statusToast || generation !== statusToastGeneration || statusToast.hidden) return;
  const result = await uiMotion.play(statusToast, [
    { opacity: 1, transform: "translate(-50%, 0)" },
    { opacity: 0, transform: "translate(-50%, 3px)" },
  ], { duration: UI_MOTION.fast, persist: true });
  if (!result.cancelled && generation === statusToastGeneration) statusToast.hidden = true;
}

function showStatusToast(message) {
  if (!statusToast) return;
  const generation = ++statusToastGeneration;
  statusToast.textContent = message;
  statusToast.hidden = false;
  void uiMotion.play(statusToast, [
    { opacity: 0, transform: "translate(-50%, 4px)" },
    { opacity: 1, transform: "translate(-50%, 0)" },
  ], { duration: UI_MOTION.panel, persist: true });
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    void hideStatusToast(generation);
  }, 3200);
}

function revealMenuContent(container, selector, options = {}) {
  requestAnimationFrame(() => {
    if (!container || container.style.display === "none") return;
    const elements = [...container.querySelectorAll(selector)].filter((element) => element.getClientRects().length > 0);
    animateElementGroup(uiMotion, elements, options);
  });
}

window.addEventListener("error", (e) => {
  showErrorOverlay(e.message + " @" + (e.filename || "").split("/").pop() + ":" + e.lineno);
});
window.addEventListener("unhandledrejection", (e) => {
  showErrorOverlay("Promise: " + (e.reason?.message || e.reason));
});

// ===== DevTools =====
function openDevTools() {
  try {
    const wv = window.__TAURI__?.webview?.getCurrentWebview();
    if (wv && wv.openDevTools) { wv.openDevTools(); return; }
    const win = window.__TAURI__?.window?.getCurrentWindow();
    if (win && win.openDevTools) win.openDevTools();
  } catch (e) {}
}

document.addEventListener("keydown", (ev) => {
  if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "d") {
    ev.preventDefault();
    openDevTools();
  }
});

const tauriCore = window.__TAURI__?.core;
const tauriWindow = window.__TAURI__?.window;
const invoke = tauriCore?.invoke;
const TauriChannel = tauriCore?.Channel;

const markdownActions = {
  notify: showStatusToast,
  openExternal: async (url) => {
    if (!invoke) throw new Error("The link-opening service is unavailable.");
    await invoke("open_external_url", { url });
  },
  openPath: async (path) => {
    if (!invoke) throw new Error("The file-opening service is unavailable.");
    await invoke("reveal_local_path", { path });
  },
};

function mountMarkdown(element, text, options = {}) {
  return renderMarkdownInto(element, String(text || ""), {
    ...options,
    actions: markdownActions,
  });
}

const logEl = document.getElementById("log");
const mainArea = document.querySelector(".main-area");
let followOutput = true;
let logRenderTarget = logEl;
const autoScrollScheduler = createFrameCoalescer(() => {
  if (followOutput) mainArea.scrollTop = mainArea.scrollHeight;
});

function appendLogElement(element) {
  logRenderTarget.appendChild(element);
  return element;
}

if (mainArea) {
  mainArea.addEventListener("scroll", () => {
    followOutput = mainArea.scrollTop >= mainArea.scrollHeight - mainArea.clientHeight - 48;
  }, { passive: true });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function autoScroll() {
  if (!mainArea || !followOutput) return;
  autoScrollScheduler.schedule();
}

function logLine(text, cls) {
  const div = document.createElement("div");
  div.className = "log-line" + (cls ? " " + cls : "");
  div.textContent = text;
  appendLogElement(div);
  autoScroll();
  return div;
}

function userBlock(text) {
  const div = document.createElement("div");
  div.className = "user-block";
  div.textContent = text;
  appendLogElement(div);
  autoScroll();
  return div;
}

function assistantFinal(text) {
  const div = document.createElement("div");
  div.className = "assistant-final rich-message";
  mountMarkdown(div, stripEmojis(replacePaths(text)));
  appendLogElement(div);
  autoScroll();
  return div;
}

function completedRichMessage(text, cls = "assistant-response") {
  const raw = stripEmojis(replacePaths(String(text || ""))).trim();
  if (!raw) return null;
  const el = document.createElement("div");
  el.className = "log-line rich-message " + cls;
  mountMarkdown(el, raw);
  appendLogElement(el);
  autoScroll();
  return el;
}

async function transitionToFinalMarkdown(el, text) {
  const rendered = stripEmojis(replacePaths(text)).trim();
  if (!el.animate) {
    mountMarkdown(el, rendered);
    return;
  }
  if (uiMotion.reducedMotion()) {
    mountMarkdown(el, rendered);
    const reduced = el.animate(
      [{ opacity: 0.82 }, { opacity: 1 }],
      { duration: 120, easing: "ease-out", fill: "both" },
    );
    try { await reduced.finished; } catch (_) {}
    return;
  }

  const outgoing = el.animate(
    [{ opacity: 1 }, { opacity: 0.76 }],
    { duration: 72, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
  );
  try { await outgoing.finished; } catch (_) {}
  mountMarkdown(el, rendered);
  const incoming = el.animate(
    [
      { opacity: 0.76, filter: "blur(0.7px)" },
      { opacity: 1, filter: "blur(0)" },
    ],
    { duration: 190, easing: "cubic-bezier(0.16, 0.82, 0.22, 1)", fill: "both" },
  );
  try { await incoming.finished; } catch (_) {}
}

function createTypewriterRenderer(el) {
  let finishing = null;
  const motion = createResponseMotionController({ element: el, onScroll: autoScroll });

  return {
    append(delta) {
      motion.append(delta);
    },
    async finish(cls) {
      if (!finishing) {
        finishing = (async () => {
          const result = await motion.finish();
          await transitionToFinalMarkdown(el, result.text);
          el.classList.remove("is-streaming", "is-typing");
          el.classList.add(cls);
          el.setAttribute("aria-busy", "false");
          el.dataset.presentationMs = String(Math.round(result.metrics.presentationMs));
          el.dataset.presentationChunks = String(result.metrics.chunks);
          autoScroll();
          return el;
        })();
      }
      return finishing;
    },
    interrupt() {
      const result = motion.interrupt();
      mountMarkdown(el, stripEmojis(replacePaths(result.text)), { streaming: true });
      el.classList.remove("is-streaming", "is-typing");
      el.classList.add("interrupted-response");
      el.setAttribute("aria-busy", "false");
    },
    get text() { return motion.text; },
  };
}

async function animatedRichMessage(text, cls = "assistant-response") {
  const raw = String(text || "");
  if (!raw.trim()) return null;
  const el = document.createElement("div");
  el.className = "log-line rich-message type-anim is-typing";
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-busy", "true");
  appendLogElement(el);
  const renderer = createTypewriterRenderer(el);
  renderer.append(raw);
  return renderer.finish(cls);
}

function logItem(label, opts) {
  opts = opts || {};
  const item = document.createElement("div");
  item.className = "log-item";
  item.dataset.status = opts.status || "busy";

  const head = document.createElement("div");
  head.className = "log-item-head";

  const status = document.createElement("span");
  const st = opts.status || "busy";
  status.className = "log-item-status st-" + st;
  status.textContent = st === "ok" ? "[OK]" : st === "err" ? "[ERR]" : st === "run" ? "[>]" : "[~]";

  const lbl = document.createElement("span");
  lbl.className = "log-item-label" + (opts.dim ? " dim" : "") + (opts.err ? " err" : "");
  if (opts.toolName) {
    const toolName = document.createElement("span");
    toolName.className = "log-item-tool";
    toolName.textContent = String(opts.toolName).replace(/_/g, " ");
    lbl.appendChild(toolName);
    if (opts.target) {
      const separator = document.createElement("span");
      separator.className = "log-item-separator";
      separator.textContent = "·";
      const target = document.createElement("span");
      target.className = "log-item-target";
      target.textContent = opts.target;
      lbl.appendChild(separator);
      lbl.appendChild(target);
    }
  } else {
    lbl.textContent = label;
  }

  const time = document.createElement("span");
  time.className = "log-item-time";
  time.textContent = opts.time || "";

  const arrow = document.createElement("span");
  arrow.className = "log-item-arrow";
  arrow.textContent = ">";

  head.appendChild(status);
  head.appendChild(lbl);
  head.appendChild(time);
  head.appendChild(arrow);

  const body = document.createElement("div");
  body.className = "log-item-body";
  const inner = document.createElement("div");
  inner.className = "log-item-body-inner";
  const content = document.createElement("div");
  content.className = "log-item-body-content";
  if (opts.bodyHtml) content.innerHTML = opts.bodyHtml;
  else if (opts.bodyText !== undefined) content.textContent = opts.bodyText;
  inner.appendChild(content);
  body.appendChild(inner);

  item.appendChild(head);
  item.appendChild(body);

  if (!opts.noToggle) {
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    head.setAttribute("aria-expanded", "false");

    const toggleItem = () => {
      const isOpen = item.classList.toggle("open");
      head.setAttribute("aria-expanded", String(isOpen));
    };

    head.addEventListener("click", toggleItem);
    head.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleItem();
      }
    });
  } else {
    arrow.style.display = "none";
    body.style.display = "none";
  }

  appendLogElement(item);
  if (!uiMotion.reducedMotion() && item.animate) {
    item.animate(
      [
        { opacity: 0, transform: "translateY(-7px) scaleY(0.76)", filter: "blur(4px)" },
        { opacity: 1, transform: "translateY(0) scaleY(1)", filter: "blur(0)" },
      ],
      { duration: 180, easing: "cubic-bezier(0.2, 0.88, 0.25, 1)" }
    );
  }
  autoScroll();
  return {
    item,
    body: content,
    lbl,
    setTime: (t) => { time.textContent = t; },
    setStatus: (s) => {
      item.dataset.status = s;
      if (s === "ok" || s === "err") {
        status.style.display = "none"; // rozet yok ? sade ve temiz
      } else {
        status.style.display = "";
        status.className = "log-item-status st-" + s;
        status.textContent = s === "run" ? "[>]" : "[~]";
      }
    },
  };
}


let HOME_DIR = "";
let WORKSPACE_DIR = "";

function shortPath(p) {
  const s = String(p || "");
  if (HOME_DIR && s.toLowerCase().startsWith(HOME_DIR.toLowerCase())) {
    return "~" + s.slice(HOME_DIR.length);
  }
  return s;
}


function replacePaths(text) {
  let s = String(text);
  if (HOME_DIR) {
    s = s.split(HOME_DIR).join("~");
  }
  return s;
}

function stripEmojis(text) {
  return String(text).replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2300}-\u{23FF}\u{2B50}\u{2728}]/gu,
    ""
  );
}

function renderAlert(msg) {
  const div = document.createElement("div");
  div.className = "alert-box";
  div.textContent = msg;
  appendLogElement(div);
  autoScroll();
  return div;
}

let spotlightCard = null;
let spotlightPoint = null;
let spotlightRect = null;
const spotlightScheduler = createFrameCoalescer(() => {
  if (!spotlightCard || !spotlightPoint) return;
  spotlightRect ||= spotlightCard.getBoundingClientRect();
  spotlightCard.style.setProperty("--mx", `${spotlightPoint.x - spotlightRect.left}px`);
  spotlightCard.style.setProperty("--my", `${spotlightPoint.y - spotlightRect.top}px`);
});

logEl.addEventListener("pointermove", (event) => {
  const card = event.target instanceof Element ? event.target.closest(".log-item") : null;
  if (card !== spotlightCard) {
    spotlightCard = card;
    spotlightRect = null;
  }
  spotlightPoint = card ? { x: event.clientX, y: event.clientY } : null;
  spotlightScheduler.schedule();
}, { passive: true });

logEl.addEventListener("pointerleave", () => {
  spotlightCard = null;
  spotlightPoint = null;
  spotlightRect = null;
});

mainArea?.addEventListener("scroll", () => { spotlightRect = null; }, { passive: true });
window.addEventListener("resize", () => { spotlightRect = null; }, { passive: true });

function createStreamRenderer() {
  const el = document.createElement("div");
  el.className = "log-line rich-message streaming-message is-streaming is-typing";
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-busy", "true");
  appendLogElement(el);
  const reduceMotion = uiMotion.reducedMotion();
  if (!reduceMotion && el.animate) {
    el.animate(
      [
        { opacity: 0, transform: "translateY(5px)", filter: "blur(2px)" },
        { opacity: 1, transform: "translateY(0)", filter: "blur(0)" },
      ],
      { duration: 180, easing: "cubic-bezier(0.2, 0.85, 0.25, 1)" }
    );
  }
  const renderer = createTypewriterRenderer(el);

  return {
    el,
    append(delta) {
      renderer.append(delta);
    },
    async finish(kind) {
      return renderer.finish(kind === "step" ? "ai-step" : "assistant-response");
    },
    interrupt() {
      renderer.interrupt();
    },
    get text() { return renderer.text; },
  };
}

let PROVIDER_REGISTRY = {
  nvidia: { id: "nvidia", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", defaultModel: "nvidia/llama-3.3-nemotron-super-49b-v1", requiresApiKey: true },
  openai: { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5.6-terra", requiresApiKey: true },
  anthropic: { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-5", requiresApiKey: true },
  gemini: { id: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-3.6-flash", requiresApiKey: true },
  groq: { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile", requiresApiKey: true },
  deepseek: { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-v4-flash", requiresApiKey: true },
  together: { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", defaultModel: "zai-org/GLM-5.1", requiresApiKey: true },
  fireworks: { id: "fireworks", name: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", defaultModel: "accounts/fireworks/routers/kimi-k2p6-turbo", requiresApiKey: true },
  openrouter: { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openrouter/auto", requiresApiKey: true },
  ollama: { id: "ollama", name: "Ollama (Local)", baseUrl: "http://localhost:11434/v1", defaultModel: "", requiresApiKey: false },
  custom: { id: "custom", name: "Custom Server", baseUrl: "", defaultModel: "", requiresApiKey: true },
};

async function hydrateProviderRegistry() {
  if (!invoke) return;
  try {
    const catalog = await invoke("provider_catalog");
    if (!Array.isArray(catalog) || catalog.length === 0) return;
    PROVIDER_REGISTRY = Object.fromEntries(catalog.map((provider) => [provider.id, provider]));
  } catch (e) {
    console.warn("Provider catalog could not be loaded; using the built-in catalog", e);
  }
}

const LEGACY_DEFAULT_MODELS = new Set([
  "gpt-4o",
  "claude-3-5-sonnet-20241022",
  "deepseek-chat",
  "deepseek-reasoner",
  "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  "auto",
  "llama3.3",
]);

function upgradeProviderConfig(config) {
  if (!config || !config.provider) return config;
  const entries = Array.isArray(config.providers) && config.providers.length
    ? config.providers
    : [{
        id: config.provider,
        baseUrl: config.baseUrl || "",
        model: config.model || "",
        protocol: config.protocol,
        authScheme: config.authScheme,
        secretRef: config.secretRef,
        modelsPath: config.modelsPath,
        chatPath: config.chatPath,
        headerNames: config.headerNames || [],
        requestTimeoutSecs: config.requestTimeoutSecs,
        allowLocalNetwork: Boolean(config.allowLocalNetwork),
        contextLimit: config.contextLimit ?? null,
        maxOutputTokens: config.maxOutputTokens ?? null,
        inputPricePerMillion: config.inputPricePerMillion ?? null,
        outputPricePerMillion: config.outputPricePerMillion ?? null,
        cachedInputPricePerMillion: config.cachedInputPricePerMillion ?? null,
        thinkingMode: config.thinkingMode ?? config.thinking_mode ?? null,
        thinkingBudget: config.thinkingBudget ?? config.thinking_budget ?? null,
      }];
  entries.forEach((entry) => {
    const id = entry.id || entry.provider;
    const provider = PROVIDER_REGISTRY[id];
    if (!provider) return;
    entry.protocol ||= provider.protocol;
    entry.authScheme ||= provider.authScheme;
    if (id === "ollama" && entry.baseUrl) entry.baseUrl = entry.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "") + "/v1";
    if (LEGACY_DEFAULT_MODELS.has(entry.model) && provider.defaultModel) entry.model = provider.defaultModel;
  });
  const active = entries.find((entry) => (entry.id || entry.provider) === config.provider);
  if (active && active !== config) {
    config.baseUrl = active.baseUrl;
    config.model = active.model;
    config.protocol = active.protocol;
    config.authScheme = active.authScheme;
    config.secretRef = active.secretRef;
    config.modelsPath = active.modelsPath;
    config.chatPath = active.chatPath;
    config.headerNames = active.headerNames || [];
    config.requestTimeoutSecs = active.requestTimeoutSecs;
    config.allowLocalNetwork = Boolean(active.allowLocalNetwork);
    config.contextLimit = active.contextLimit ?? config.contextLimit ?? null;
    config.maxOutputTokens = active.maxOutputTokens ?? null;
    config.inputPricePerMillion = active.inputPricePerMillion ?? null;
    config.outputPricePerMillion = active.outputPricePerMillion ?? null;
    config.cachedInputPricePerMillion = active.cachedInputPricePerMillion ?? null;
    config.thinkingMode = active.thinkingMode ?? active.thinking_mode ?? config.thinkingMode ?? config.thinking_mode ?? null;
    config.thinkingBudget = active.thinkingBudget ?? active.thinking_budget ?? config.thinkingBudget ?? config.thinking_budget ?? null;
  } else {
    const provider = PROVIDER_REGISTRY[config.provider];
    if (provider) {
      config.protocol ||= provider.protocol;
      config.authScheme ||= provider.authScheme;
      if (LEGACY_DEFAULT_MODELS.has(config.model) && provider.defaultModel) config.model = provider.defaultModel;
    }
  }
  config.providers = entries;
  return scrubSecrets(config);
}

// ===== STATE =====
let isInitialized = false;
let providerNameCache = null;
let configCache = null;

const SECRET_CONFIG_FIELDS = new Set([
  "apikey",
  "api_key",
  "token",
  "accesstoken",
  "access_token",
  "password",
  "secret",
  "secretvalue",
  "headervalues",
]);

function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (!value || typeof value !== "object") return value;
  const clean = {};
  Object.entries(value).forEach(([key, child]) => {
    if (SECRET_CONFIG_FIELDS.has(key.toLowerCase())) return;
    clean[key] = scrubSecrets(child);
  });
  return clean;
}

function safeError(error) {
  return String(error || "Unknown error")
    .replace(/Bearer\s+[^\s"',}\]]+/gi, "Bearer ***")
    .replace(/([?&]key=)[^&\s"']+/gi, "$1***")
    .replace(/(?:sk-ant-|sk-|gsk_|AIza|nvapi-)[A-Za-z0-9._-]+/g, "***");
}

function hasProviderCredential(entry, provider = null) {
  if (!entry) return false;
  const authScheme = entry.authScheme || (provider && provider.authScheme);
  const hasSecretHeaders = Array.isArray(entry.headerNames) && entry.headerNames.length > 0;
  return (authScheme === "none" && !hasSecretHeaders) || Boolean(entry.secretRef);
}

function persistConfigCache() {
  configCache = scrubSecrets(configCache);
  try { localStorage.removeItem("appConfig"); } catch (e) {}
}

function loadConfigCache() {
  try {
    const raw = localStorage.getItem("appConfig");
    if (raw) {
      configCache = scrubSecrets(JSON.parse(raw));
      if (configCache && !configCache.mode) configCache.mode = "smart";
      localStorage.removeItem("appConfig");
    }
  } catch (e) {}
}

const apiModal = document.getElementById("api-modal");
const apiKeyInput = document.getElementById("api-key-input");
const apiKeySubtext = document.getElementById("api-key-subtext");
const apiKeyError = document.getElementById("api-key-error");
const apiProviderTitle = document.getElementById("api-provider-title");
const customProviderFields = document.getElementById("custom-provider-fields");
const customBaseUrl = document.getElementById("custom-base-url");
const customModelId = document.getElementById("custom-model-id");
const customProtocol = document.getElementById("custom-protocol");
const customAuthScheme = document.getElementById("custom-auth-scheme");
const customModelsPath = document.getElementById("custom-models-path");
const customChatPath = document.getElementById("custom-chat-path");
const customTimeout = document.getElementById("custom-timeout");
const customHeaders = document.getElementById("custom-headers");
const customAllowLocal = document.getElementById("custom-allow-local");
const apiSurface = apiModal.querySelector(".api-window");
const apiVisibility = createVisibilityController(uiMotion, {
  root: apiModal,
  surface: apiSurface,
  openDuration: UI_MOTION.fast,
  surfaceOpenDuration: UI_MOTION.dialog,
  closeDuration: UI_MOTION.fast,
  surfaceCloseDuration: UI_MOTION.fast,
});
let apiModalProvider = null;

function parseSecretHeaders(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator <= 0) throw new Error("Header format must be 'Name: Value'");
      return { name: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() };
    });
}

function openApiModal(p, prefill) {
  apiModalProvider = p;
  void apiVisibility.open();
  apiKeyInput.value = "";
  apiKeyError.textContent = "";
  apiKeyInput.classList.remove("error");
  apiProviderTitle.textContent = p.name;
  const isCustom = p.id === "custom";
  customProviderFields.style.display = isCustom ? "grid" : "none";
  if (isCustom) {
    customBaseUrl.value = prefill?.baseUrl || p.baseUrl || "";
    customModelId.value = prefill?.model || p.model || p.defaultModel || "";
    customProtocol.value = prefill?.protocol || p.protocol || "openai_chat";
    customAuthScheme.value = prefill?.authScheme || p.authScheme || "bearer";
    customModelsPath.value = prefill?.modelsPath || p.modelsPath || "";
    customChatPath.value = prefill?.chatPath || p.chatPath || "";
    customTimeout.value = String(prefill?.requestTimeoutSecs || p.requestTimeoutSecs || 45);
    customHeaders.value = "";
    customAllowLocal.checked = Boolean(prefill?.allowLocalNetwork || p.allowLocalNetwork);
    apiKeySubtext.textContent = "Enter server details and press Enter";
    requestAnimationFrame(() => customBaseUrl.focus());
  } else if (!p.requiresApiKey) {
    apiKeySubtext.textContent = "Connecting...";
    connectProvider(p, "");
  } else {
    apiKeySubtext.textContent = p.name + " API Key";
    requestAnimationFrame(() => apiKeyInput.focus());
  }
  revealMenuContent(apiSurface, ".api-provider-title, .modal-api-field, .custom-provider-fields > *, .modal-api-meta", {
    delay: 54,
    stagger: 22,
    maxItems: 10,
  });
}

function closeApiModal() {
  apiKeyInput.value = "";
  customHeaders.value = "";
  void apiVisibility.close();
  apiModalProvider = null;
  cmdInput.focus();
}

async function connectProvider(provider, apiKey) {
  try {
    const isCustom = provider.id === "custom";
    const baseUrl = isCustom ? customBaseUrl.value.trim().replace(/\/$/, "") : provider.baseUrl;
    const protocol = isCustom ? customProtocol.value : provider.protocol;
    const authScheme = isCustom ? customAuthScheme.value : provider.authScheme;
    const manualModel = isCustom ? customModelId.value.trim() : "";
    const modelsPath = isCustom ? customModelsPath.value.trim() || null : null;
    const chatPath = isCustom ? customChatPath.value.trim() || null : null;
    const headers = isCustom ? parseSecretHeaders(customHeaders.value) : [];
    const requestTimeoutSecs = isCustom ? Number(customTimeout.value || 45) : null;
    const allowLocalNetwork = isCustom ? customAllowLocal.checked : false;
    if (!baseUrl) throw new Error("Base URL is required");
    countApiCall();
    const connected = await invoke("connect_provider_secure", {
      connection: {
        provider: provider.id,
        apiKey,
        baseUrl,
        model: manualModel,
        protocol: protocol || null,
        authScheme: authScheme || null,
        modelsPath,
        chatPath,
        headers,
        replaceHeaders: false,
        requestTimeoutSecs,
        allowLocalNetwork,
      },
    });
    const validation = connected.validation;
    const selectedModel = manualModel || validation.recommendedModel || provider.defaultModel;
    if (!selectedModel) throw new Error("No compatible agent model was found");

    const prev = configCache || (await invoke("get_config")) || {};
    const newProvider = {
      id: provider.id,
      baseUrl,
      model: selectedModel,
      protocol,
      authScheme,
      secretRef: connected.secretRef,
      modelsPath,
      chatPath,
      headerNames: connected.headerNames || [],
      requestTimeoutSecs,
      allowLocalNetwork,
      contextLimit: null,
      maxOutputTokens: null,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      cachedInputPricePerMillion: null,
    };
    const providers = Array.isArray(prev.providers) && prev.providers.length > 0
      ? prev.providers.filter((p) => (p.id || p.provider) !== provider.id)
      : (prev.provider ? [{
          id: prev.provider,
          baseUrl: prev.baseUrl,
          model: prev.model,
          protocol: prev.protocol,
          authScheme: prev.authScheme,
          secretRef: prev.secretRef,
          modelsPath: prev.modelsPath,
          chatPath: prev.chatPath,
          headerNames: prev.headerNames || [],
          requestTimeoutSecs: prev.requestTimeoutSecs,
          allowLocalNetwork: Boolean(prev.allowLocalNetwork),
          contextLimit: prev.contextLimit ?? null,
          maxOutputTokens: prev.maxOutputTokens ?? null,
          inputPricePerMillion: prev.inputPricePerMillion ?? null,
          outputPricePerMillion: prev.outputPricePerMillion ?? null,
          cachedInputPricePerMillion: prev.cachedInputPricePerMillion ?? null,
        }] : []);
    providers.push(newProvider);

    configCache = {
      provider: provider.id,
      baseUrl,
      model: selectedModel,
      protocol,
      authScheme,
      secretRef: connected.secretRef,
      modelsPath,
      chatPath,
      headerNames: connected.headerNames || [],
      requestTimeoutSecs,
      allowLocalNetwork,
      mode: prev.mode || "smart",
      allowList: prev.allowList || [],
      contextLimit: null,
      contextRatio: prev.contextRatio || null,
      maxOutputTokens: null,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      cachedInputPricePerMillion: null,
      providers,
    };
    await invoke("save_config", { config: configCache });
    isInitialized = true;
    modelCache = null;
    providerNameCache = provider.name;
    persistConfigCache();
    closeApiModal();
    openModelMenu();
  } catch (e) {
    apiKeyInput.classList.add("error");
    apiKeyError.textContent = "Could not connect — " + safeError(e);
    apiKeySubtext.textContent = "";
    setTimeout(() => apiKeyInput.classList.remove("error"), 1500);
  } finally {
    apiKeyInput.value = "";
    customHeaders.value = "";
  }
}

document.addEventListener("keydown", (ev) => {
  if (apiModal.style.display !== "flex") return;
  if (ev.key === "Enter") {
    ev.preventDefault();
    if (!apiModalProvider) return;
    const key = apiKeyInput.value.trim();
    const keyRequired = apiModalProvider.id === "custom"
      ? customAuthScheme.value !== "none"
      : apiModalProvider.requiresApiKey;
    if (!key && keyRequired) {
      apiKeyInput.classList.add("error");
      apiKeyError.textContent = "Invalid API key";
      setTimeout(() => apiKeyInput.classList.remove("error"), 1500);
      return;
    }
    apiKeySubtext.textContent = "Verifying...";
    connectProvider(apiModalProvider, key);
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    closeApiModal();
  }
});

const btnClose = document.getElementById("btn-close");
const btnMin = document.getElementById("btn-min");
const btnMax = document.getElementById("btn-max");

if (btnClose) btnClose.addEventListener("click", async () => { try { await tauriWindow?.getCurrentWindow()?.close(); } catch (e) {} });
if (btnMin) btnMin.addEventListener("click", async () => { try { await tauriWindow?.getCurrentWindow()?.minimize(); } catch (e) {} });
if (btnMax) btnMax.addEventListener("click", async () => { try { await tauriWindow?.getCurrentWindow()?.toggleMaximize(); } catch (e) {} });

const modelChip = document.getElementById("model-chip");
const modelNameEl = document.getElementById("model-name");
const thinkingChip = document.getElementById("thinking-chip");
const thinkingNameEl = document.getElementById("thinking-name");
const thinkingInlineBar = document.getElementById("thinking-inline-bar");
const thinkingInlineTrack = document.getElementById("thinking-inline-track");
const pathEl = document.getElementById("path");
const ctxFill = document.getElementById("ctx-fill");
const ctxGaugeFill = document.getElementById("ctx-gauge-fill");
const ctxPct = document.getElementById("ctx-pct");
const ctxStatus = document.getElementById("ctx-status");
const apiCountEl = document.getElementById("api-count");

let thinkingModesList = [];
let thinkingActiveIndex = 0;
let isThinkingBarOpen = false;

let apiCallCount = 0;
function countApiCall() {
  apiCallCount++;
  if (apiCountEl) apiCountEl.textContent = "API " + apiCallCount;
}

function setAgentState(state) {
  if (ctxStatus) ctxStatus.dataset.state = state;
}

function shortModelName(model) {
  const id = String(model || "").split("/").pop();
  const acronyms = new Map([
    ["gpt", "GPT"], ["glm", "GLM"], ["llama", "Llama"], ["qwen", "Qwen"],
    ["gemini", "Gemini"], ["claude", "Claude"], ["mistral", "Mistral"],
    ["mini", "Mini"], ["nano", "Nano"], ["pro", "Pro"], ["flash", "Flash"],
    ["lite", "Lite"], ["sonnet", "Sonnet"], ["opus", "Opus"], ["haiku", "Haiku"],
    ["instruct", "Instruct"], ["thinking", "Thinking"], ["preview", "Preview"],
  ]);
  return id.split(/[-_]+/).filter(Boolean).map((part) => {
    const lower = part.toLowerCase();
    if (acronyms.has(lower)) return acronyms.get(lower);
    if (/^r\d+$/i.test(part)) return part.toUpperCase();
    if (/^\d+(?:\.\d+)?b$/i.test(part)) return part.toUpperCase();
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(" ").slice(0, 34);
}

function updateModelChip(model, displayName = "") {
  if (modelChip && modelNameEl) {
    modelNameEl.textContent = displayName || shortModelName(model);
    modelChip.title = model || "";
  }
  updateThinkingChip();
  updateCtxGauge();
}

if (modelChip) {
  modelChip.addEventListener("click", () => openModelMenu());
}

if (thinkingChip) {
  thinkingChip.addEventListener("click", () => toggleThinkingBar());
}

if (ctxStatus) {
  ctxStatus.addEventListener("click", () => renderSessionStatus());
}

function updatePath(cwd) {
  if (!pathEl) return;
  let raw = String(cwd || "~");
  if (/^\.[\\/]?$/.test(raw) && WORKSPACE_DIR) raw = WORKSPACE_DIR;
  const shortened = shortPath(raw).replace(/\\/g, "/");
  const parts = shortened.split("/").filter((part) => part && part !== "~");
  const last = parts[parts.length - 1];

  if (!last) {
    pathEl.textContent = "~";
  } else if (shortened.startsWith("~")) {
    pathEl.textContent = "~/" + last;
  } else if (/^[A-Za-z]:/.test(shortened)) {
    pathEl.textContent = last;
  } else {
    pathEl.textContent = "./" + last;
  }

  pathEl.title = raw;
}

const DIRECTORY_TOOLS = new Set([
  "list_dir",
  "search_code",
  "analyze_codebase",
  "create_dir",
]);

function toolWorkingPath(toolId, params) {
  const rawPath = String(params.path || "").trim();
  if (!rawPath) return "";
  if (DIRECTORY_TOOLS.has(toolId)) return rawPath;

  const slash = Math.max(rawPath.lastIndexOf("/"), rawPath.lastIndexOf("\\"));
  if (slash < 0) return ".";
  if (slash === 2 && /^[A-Za-z]:[\\/]$/.test(rawPath.slice(0, 3))) {
    return rawPath.slice(0, 3);
  }
  return rawPath.slice(0, slash) || ".";
}

// ===== CONTEXT MANAGER =====
function contextLimitOf(config) {
  const v = config && config.contextLimit ? Number(config.contextLimit) : 0;
  return v >= 8000 && v <= 4000000 ? v : 131072;
}

function contextRatioOf(config) {
  const r = config && config.contextRatio !== undefined ? Number(config.contextRatio) : NaN;
  return !isNaN(r) && r > 0 && r <= 1 ? r : 0.8;
}

function outputReserveOf(config) {
  const limit = contextLimitOf(config);
  const configured = Number(config?.maxOutputTokens || 0);
  const reserve = configured > 0 ? configured : 8192;
  return Math.min(Math.floor(limit * 0.25), Math.max(2048, reserve));
}

function usableContextLimit(config) {
  return Math.max(4096, contextLimitOf(config) - outputReserveOf(config));
}

function compactThresholdFor(config) {
  return Math.floor(usableContextLimit(config) * contextRatioOf(config));
}

function estimateTokens(history) {
  let total = 0;
  for (const m of history) {
    total += 4;
    total += Math.ceil(String(m.content || "").length / 4);
    if (m.toolCalls) total += Math.ceil(JSON.stringify(m.toolCalls).length / 4);
    if (m.toolCallId) total += Math.ceil(String(m.toolCallId).length / 4);
    if (m.reasoningContent) total += Math.ceil(String(m.reasoningContent).length / 4);
  }
  return total;
}

function fmtK(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

function defaultSessionUsage() {
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

function defaultCompactionState() {
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

function normalizeSessionIntelligence(record) {
  if (!record) return record;
  record.usage = { ...defaultSessionUsage(), ...(record.usage || {}) };
  record.compaction = { ...defaultCompactionState(), ...(record.compaction || {}) };
  record.compaction.autoEnabled = record.compaction.autoEnabled !== false;
  const threshold = Number(record.compaction.threshold);
  record.compaction.threshold = threshold >= 0.5 && threshold <= 0.95 ? threshold : 0.8;
  return record;
}

function effectiveConversationHistory() {
  const state = currentSession?.compaction;
  if (!state?.summary || !Number.isInteger(state.compactedThrough) || state.compactedThrough <= 0) {
    return conversationHistory.slice();
  }
  return [
    {
      role: "system",
      content: "## Compacted session memory\nThis summary is the verified continuation context for earlier conversation turns.\n\n" + state.summary,
    },
    ...conversationHistory.slice(state.compactedThrough),
  ];
}

function effectiveRequestHistory(config, homeDir) {
  return [
    { role: "system", content: buildSystemPrompt(config, homeDir) },
    ...effectiveConversationHistory(),
  ];
}

function turnCostUsd(usage, config) {
  if (config?.inputPricePerMillion === null || config?.inputPricePerMillion === undefined
      || config?.outputPricePerMillion === null || config?.outputPricePerMillion === undefined) {
    return null;
  }
  const inputPrice = Number(config?.inputPricePerMillion);
  const outputPrice = Number(config?.outputPricePerMillion);
  const hasCachedPrice = config?.cachedInputPricePerMillion !== null
    && config?.cachedInputPricePerMillion !== undefined;
  const cachedPriceValue = Number(config?.cachedInputPricePerMillion);
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) return null;
  const input = Number(usage.inputTokens || 0);
  const output = Number(usage.outputTokens || 0);
  const cached = Math.min(input, Number(usage.cachedTokens || 0));
  const uncached = Math.max(0, input - cached);
  const cachedPrice = hasCachedPrice && Number.isFinite(cachedPriceValue) ? cachedPriceValue : inputPrice;
  return ((uncached * inputPrice) + (cached * cachedPrice) + (output * outputPrice)) / 1_000_000;
}

function recordReplyUsage(reply, history, { updateContext = true } = {}) {
  if (!currentSession) return;
  normalizeSessionIntelligence(currentSession);
  const totals = currentSession.usage;
  const providerUsage = reply?.usage || {};
  const reported = [
    providerUsage.inputTokens,
    providerUsage.outputTokens,
    providerUsage.reasoningTokens,
    providerUsage.cachedTokens,
    providerUsage.totalTokens,
  ].some((value) => Number(value) > 0);
  const usage = reported
    ? {
        inputTokens: Number(providerUsage.inputTokens || 0),
        outputTokens: Number(providerUsage.outputTokens || 0),
        reasoningTokens: Number(providerUsage.reasoningTokens || 0),
        cachedTokens: Number(providerUsage.cachedTokens || 0),
        totalTokens: Number(providerUsage.totalTokens || 0),
      }
    : {
        inputTokens: estimateTokens(history || []),
        outputTokens: Math.ceil(String(reply?.text || "").length / 4),
        reasoningTokens: Math.ceil(String(reply?.reasoning || "").length / 4),
        cachedTokens: 0,
        totalTokens: 0,
      };
  if (!usage.totalTokens) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.reasoningTokens;
  }
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.reasoningTokens += usage.reasoningTokens;
  totals.cachedTokens += usage.cachedTokens;
  totals.totalTokens += usage.totalTokens;
  totals.apiCalls += 1;
  totals.source = totals.source && totals.source !== (reported ? "provider" : "estimated")
    ? "mixed"
    : (reported ? "provider" : "estimated");
  if (updateContext) totals.currentContextTokens = usage.totalTokens;
  if (reply?.rate_limits) totals.rateLimits = reply.rate_limits;
  const cost = turnCostUsd(usage, configCache);
  if (cost !== null) totals.costUsd = Number(totals.costUsd || 0) + cost;
}

function currentContextTokens(history = null) {
  const measured = Number(currentSession?.usage?.currentContextTokens || 0);
  return measured > 0 ? measured : estimateTokens(history || effectiveConversationHistory());
}

function getThinkingModesFor(providerId, modelId) {
  const cachedModel = (modelCache?.items || []).find((m) => m.id === modelId);

  // Read reasoning_options / variants directly from the model returned by the API
  const apiOptions = cachedModel?.reasoningOptions || cachedModel?.reasoning_options || cachedModel?.variants;
  if (Array.isArray(apiOptions) && apiOptions.length > 0) {
    return apiOptions.map((opt) => {
      if (typeof opt === "string") {
        return { id: opt, label: opt };
      }
      if (opt && typeof opt === "object") {
        return {
          id: opt.id || opt.name || opt.value || String(opt),
          label: opt.label || opt.name || opt.id || opt.value || String(opt),
          budget: opt.budget ?? opt.budgetTokens ?? opt.budget_tokens ?? undefined,
        };
      }
      return { id: String(opt), label: String(opt) };
    });
  }

  // If no reasoning options are returned by the API / model, show only standard:
  return [{ id: "off", label: "standard", budget: 0 }];
}

function updateThinkingChip(modeId = null) {
  if (!thinkingNameEl) return;
  const config = configCache;
  const providerId = config?.provider || "openai";
  const modelId = config?.model || "";
  thinkingModesList = getThinkingModesFor(providerId, modelId);
  const currentModeId = modeId || config?.thinking_mode || thinkingModesList[0]?.id;
  const currentIdx = thinkingModesList.findIndex((m) => m.id === currentModeId);
  thinkingActiveIndex = currentIdx >= 0 ? currentIdx : 0;
  const activeMode = thinkingModesList[thinkingActiveIndex] || thinkingModesList[0];

  thinkingNameEl.textContent = activeMode?.label || activeMode?.id || "standard";
  if (thinkingChip) {
    thinkingChip.title = `Thinking: ${activeMode?.label || activeMode?.id} (Click to change)`;
  }
}

function openThinkingBar() {
  if (!thinkingInlineBar || !thinkingInlineTrack) return;
  const config = configCache;
  const providerId = config?.provider || "openai";
  const modelId = config?.model || "";
  thinkingModesList = getThinkingModesFor(providerId, modelId);
  const currentModeId = config?.thinking_mode || thinkingModesList[0]?.id;
  const currentIdx = thinkingModesList.findIndex((m) => m.id === currentModeId);
  thinkingActiveIndex = currentIdx >= 0 ? currentIdx : 0;

  renderThinkingInlineTrack();
  thinkingInlineBar.style.display = "inline-flex";
  isThinkingBarOpen = true;
  if (thinkingChip) thinkingChip.classList.add("is-open");
}

function closeThinkingBar() {
  if (!thinkingInlineBar) return;
  thinkingInlineBar.style.display = "none";
  isThinkingBarOpen = false;
  if (thinkingChip) thinkingChip.classList.remove("is-open");
}

function toggleThinkingBar() {
  if (isThinkingBarOpen) {
    closeThinkingBar();
  } else {
    openThinkingBar();
  }
}

function renderThinkingInlineTrack() {
  if (!thinkingInlineTrack) return;
  thinkingInlineTrack.innerHTML = "";

  const count = thinkingModesList.length;
  if (count === 0) return;

  thinkingModesList.forEach((mode, idx) => {
    // 1. Major Tick Column
    const col = document.createElement("div");
    col.className = `ruler-major-col ${idx === thinkingActiveIndex ? "is-selected" : ""}`;
    col.setAttribute("data-mode-id", mode.id);

    const mark = document.createElement("div");
    mark.className = "ruler-major-mark";
    col.appendChild(mark);

    // Hover previews mode in left chip without any box or popup
    col.addEventListener("mouseenter", () => {
      if (thinkingNameEl) thinkingNameEl.textContent = mode.label || mode.id;
    });

    col.addEventListener("mouseleave", () => {
      const active = thinkingModesList[thinkingActiveIndex];
      if (thinkingNameEl && active) thinkingNameEl.textContent = active.label || active.id;
    });

    col.addEventListener("click", (e) => {
      e.stopPropagation();
      thinkingActiveIndex = idx;
      void applyThinkingSelection(mode.id);
      renderThinkingInlineTrack();
    });

    thinkingInlineTrack.appendChild(col);

    // 2. Minor Ticks between major ticks (evenly distributed)
    if (idx < count - 1) {
      const minorGrp = document.createElement("div");
      minorGrp.className = "ruler-minor-group";
      for (let m = 0; m < 2; m++) {
        const mTick = document.createElement("div");
        mTick.className = "ruler-minor-tick";
        minorGrp.appendChild(mTick);
      }
      thinkingInlineTrack.appendChild(minorGrp);
    }
  });
}

async function applyThinkingSelection(modeId) {
  if (!configCache) return;
  configCache.thinking_mode = modeId;
  const mode = thinkingModesList.find((m) => m.id === modeId);
  if (mode && mode.budget !== undefined) {
    configCache.thinking_budget = mode.budget;
  }
  if (Array.isArray(configCache.providers)) {
    const activeEntry = configCache.providers.find((p) => (p.id || p.provider) === configCache.provider);
    if (activeEntry) {
      activeEntry.thinking_mode = modeId;
      if (mode && mode.budget !== undefined) activeEntry.thinking_budget = mode.budget;
    }
  }
  try {
    await invoke("save_config", { config: configCache });
  } catch (e) {}
  persistConfigCache();
  updateThinkingChip(modeId);
}

function updateCtxGauge(history = null, reply = null) {
  if (!ctxStatus) return;
  const config = configCache;
  const limit = contextLimitOf(config);
  const ratio = contextRatioOf(config);
  const measuredTotal = Number(reply?.usage?.totalTokens || 0);
  const total = measuredTotal > 0
    ? measuredTotal
    : currentContextTokens(history || effectiveConversationHistory());
  const pct = limit > 0 ? Math.min(100, Math.max(0, (total / limit) * 100)) : 0;

  // SVG Radial Gauge Math (r = 8.5 -> circumference = 53.407)
  const circumference = 53.407;
  if (ctxGaugeFill) {
    const offset = total > 0
      ? circumference - Math.max(1.8, (pct / 100) * circumference)
      : circumference;
    ctxGaugeFill.style.strokeDashoffset = String(offset);
  }

  if (ctxPct) {
    ctxPct.textContent = Math.round(pct) + "%";
  }

  ctxStatus.classList.toggle("mid", pct > 70 && pct <= 90);
  ctxStatus.classList.toggle("high", pct > 90);

  if (ctxFill) {
    const tone = pct > 90 ? "#f87171" : pct > 70 ? "#facc15" : "#ffffff";
    ctxFill.style.setProperty("--ctx-angle", (pct * 3.6) + "deg");
    ctxFill.style.setProperty("--ctx-tone", tone);
  }

  const source = currentSession?.usage?.source || (measuredTotal > 0 ? "provider" : "estimated");
  ctxStatus.title = "Context: " + fmtK(total) + " / " + fmtK(limit) + " (" + pct.toFixed(1) + "%) — " + source + " · Click for session status";
  ctxStatus.setAttribute("aria-valuenow", String(Math.round(pct)));
  ctxStatus.setAttribute("aria-label", "Context " + Math.round(pct) + " percent");
}

// ===== SYSTEM PROMPT =====
function buildSystemPrompt(config, homeDir) {
  return (
    "You are a terminal assistant operating on the user's computer. You call tools to read, write, search files, run commands, fetch web pages, manage processes, and delegate subtasks. Execute the user's request end-to-end like a senior developer.\n\n" +
    "## Environment\n" +
    "- OS: Windows — shell commands run through cmd; bash/Linux commands (ls, uname, pwd, $HOME, ~, 2>/dev/null) do NOT work.\n" +
    "- Home directory: " + (homeDir || "(resolve at runtime)") +
    "\n- Desktop is usually <home>\\Desktop, but may be redirected (e.g. OneDrive: <home>\\OneDrive\\Desktop). Discover the real location with list_dir — never guess.\n" +
    "- Resolve all paths dynamically. If a path is unknown, verify it with list_dir before assuming.\n" +
    "- NEVER probe for paths with shell commands (whoami, echo $HOME, powershell GetFolderPath, cd, dir) — use list_dir/read_file instead.\n\n" +
    "## Identity\n" +
    "- Your model identity is: " + config.model + ". State it verbatim when asked.\n" +
    "- You are an agent, not a chatbot: complete tasks with tools, do not just discuss them.\n\n" +
    "## Task Execution (To-Do Engine)\n" +
    "- Break complex requests into logical steps and execute them in order.\n" +
    "- Work on ONE step at a time. Do not attempt everything in a single tool call.\n" +
    "- Keep the user informed briefly: what you are doing and why (1 short line per step).\n" +
    "- Track progress mentally across turns — tool results are the ground truth of what has been done.\n" +
    "- Short follow-ups (\"continue\", \"devam et\", \"fix it\", \"hatayı düzelt\") refer to the CURRENT task: resume from the last tool result, never restart from zero.\n\n" +
    "## Auto-Plan Mode\n" +
    "- Complex/multi-step tasks (3+ actions, file modifications, investigations): BEFORE acting, present a short numbered plan (2-5 steps) to the user, then execute it step by step.\n" +
    "- Simple tasks (single read, quick answer): act immediately, no plan needed.\n" +
    "- After completing all plan steps, close with a concise summary of what was done.\n\n" +
    "## Mid-Flight Steering\n" +
    "- If the user interrupts (\"dur\", \"stop\", \"bekle\", \"wait\", \"change\", \"değiştir\", new instructions): stop the current action chain immediately and follow the new direction. Do not finish the old plan first.\n" +
    "- Preserve context from previous steps — the user expects continuity, not a fresh start.\n\n" +
    "## Tool Usage Discipline\n" +
    "- Choose the most specific tool for the job: read_file for content, list_dir for directory structure, search_code for locating symbols, web_fetch for web content, execute_command for shell operations.\n" +
    "- NEVER use shell commands (curl, Invoke-WebRequest, Out-File, dir, type, ls) for file or web operations — always use the built-in tools.\n" +
    "- Do not chain speculative attempts (trying ls, then echo, then find). Pick ONE correct approach and execute it.\n" +
    "- Pass complete, correct parameters. Verify paths before destructive or write operations.\n" +
    "- Do not call a tool when you already have the answer from previous results.\n" +
    "- If a tool returns an error, correct your parameters and retry — retrying the same call is allowed and expected.\n\n" +
    "## Error Handling & Self-Correction\n" +
    "- Tool errors are normal: analyze the message (HTTP status, os error, missing path), fix the cause, retry with corrected parameters or a different tool.\n" +
    "- NEVER abandon the task or send a greeting (\"Hello! How can I help?\") after an error.\n" +
    "- If the same approach fails twice, change strategy entirely (different tool, different path, different command).\n\n" +
    "## Verification & Quality\n" +
    "- After write/edit/delete operations, verify the result (read_file or list_dir) before reporting success.\n" +
    "- Do not report success based on assumption — confirm with tool output.\n" +
    "- Finish with a short summary: what was done, what changed, and any follow-up needed.\n\n" +
    "## Memory\n" +
    "- Use manage_memory to persist important project facts (decisions, structures, learned gotchas) for future sessions.\n" +
    "- Read memory before starting a task that seems related to previous work.\n" +
    "- Memory keys should be short and semantic.\n\n" +
    "## Sub-Agent Delegation\n" +
    "- Use spawn_sub_agent for independent, well-scoped subtasks that do not need your current context (isolated research, long computations, separate concerns).\n" +
    "- Keep the main task and context for yourself; delegate only what can stand alone.\n" +
    "- Incorporate the sub-agent report into your final answer.\n\n" +
    "## Safety & Guardrails\n" +
    "- NEVER propose or run destructive commands (rm -rf, format, shutdown, diskpart, mkfs, Remove-Item -Recurse).\n" +
    "- Be careful around sensitive paths (.env, .git, node_modules, system folders) — ask or avoid modifying them.\n" +
    "- Respect permission prompts: if approval is required, wait; do not attempt to bypass it.\n\n" +
    "## Communication\n" +
    "- Respond in the same language the user writes in.\n" +
    "- Be concise: short sentences, no filler. Use Markdown when it improves structure.\n" +
    "- Before tool calls, write exactly one short progress sentence. Put file paths, commands, and identifiers in `backticks`; do not add emoji or a heading because the UI supplies the step marker. After presenting a plan, do not prefix later progress updates with Step, Adım, or another repeated number.\n" +
    "- In final answers, use short headings, lists, bold labels, inline code, and code blocks only when they materially improve readability.\n" +
    "- Plans and summaries: keep them clean and readable."
  );
}

// ===== SUGGEST PANEL =====
const suggestPanel = document.getElementById("suggest-panel");
const COMMANDS = ["/model", "/thinking", "/provider", "/diagnostics", "/permissions", "/status", "/compact", "/sessions", "/resume", "/delete-session", "/new", "/undo", "/clear"];
let suggestMode = null;
let suggestItems = [];
let suggestIndex = 0;
let suggestRows = [];
let suggestGeneration = 0;
let pendingSuggestActive = null;
const suggestVisibility = createVisibilityController(uiMotion, {
  root: suggestPanel,
  surface: suggestPanel,
  display: "block",
  openDuration: UI_MOTION.panel,
  closeDuration: UI_MOTION.fast,
  rootOpenFrom: { opacity: 0, transform: "translate(-50%, 12px) scale(0.975)" },
  rootOpenTo: { opacity: 1, transform: "translate(-50%, 0) scale(1)" },
  rootCloseTo: { opacity: 0, transform: "translate(-50%, 6px) scale(0.985)" },
});
const suggestSelection = createSelectionController(uiMotion, {
  container: suggestPanel,
  markerClass: "menu-selection-chevron suggest-selection-chevron",
});
const suggestInputOwner = createSelectionInputController(suggestPanel);
const suggestScrollScheduler = createFrameCoalescer(() => {
  const active = pendingSuggestActive;
  if (!active || !suggestPanel.clientHeight) return;
  const top = active.offsetTop;
  const bottom = top + active.offsetHeight;
  if (top < suggestPanel.scrollTop) suggestPanel.scrollTop = top;
  else if (bottom > suggestPanel.scrollTop + suggestPanel.clientHeight) {
    suggestPanel.scrollTop = bottom - suggestPanel.clientHeight;
  }
});

function showSuggest(items, mode) {
  const generation = ++suggestGeneration;
  suggestMode = mode;
  suggestItems = items;
  suggestIndex = 0;
  suggestPanel.scrollTop = 0;
  suggestPanel.innerHTML = "";
  suggestPanel.setAttribute("role", "listbox");
  suggestRows = [];
  suggestInputOwner.claimKeyboard();
  items.forEach((it, i) => {
    const el = document.createElement("div");
    el.className = "suggest-item";
    el.textContent = typeof it === "string" ? it : (it.name || it.id);
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", "false");
    el.addEventListener("mouseenter", () => {
      if (!suggestInputOwner.acceptsPointer()) return;
      suggestIndex = i;
      updateActiveItem();
    });
    el.addEventListener("click", () => {
      suggestInputOwner.claimPointer();
      suggestIndex = i;
      void applySuggest(suggestIndex);
    });
    suggestPanel.appendChild(el);
    suggestRows.push(el);
  });
  suggestSelection.setRows(suggestRows);
  suggestSelection.moveTo(0, { immediate: true });
  void suggestVisibility.open().then(() => {
    if (generation === suggestGeneration) suggestPanel.dataset.motionReady = "true";
  });
}

function updateActiveItem() {
  const active = suggestSelection.moveTo(suggestIndex);
  if (!active) return;
  pendingSuggestActive = active;
  suggestScrollScheduler.schedule();
}

function moveSuggestSelection(key) {
  if (!suggestItems.length) return false;
  const visibleRows = Math.max(1, Math.floor(suggestPanel.clientHeight / (suggestRows[0]?.offsetHeight || 34)) - 1);
  if (key === "ArrowDown") suggestIndex = (suggestIndex + 1) % suggestItems.length;
  else if (key === "ArrowUp") suggestIndex = (suggestIndex - 1 + suggestItems.length) % suggestItems.length;
  else if (key === "Home") suggestIndex = 0;
  else if (key === "End") suggestIndex = suggestItems.length - 1;
  else if (key === "PageDown") suggestIndex = Math.min(suggestItems.length - 1, suggestIndex + visibleRows);
  else if (key === "PageUp") suggestIndex = Math.max(0, suggestIndex - visibleRows);
  else return false;
  suggestInputOwner.claimKeyboard();
  updateActiveItem();
  return true;
}

function hideSuggest() {
  const generation = ++suggestGeneration;
  suggestItems = [];
  suggestIndex = 0;
  suggestMode = null;
  void suggestVisibility.close().then(() => {
    if (generation !== suggestGeneration || suggestMode !== null) return;
    suggestSelection.reset();
    suggestPanel.innerHTML = "";
    suggestRows = [];
    pendingSuggestActive = null;
    delete suggestPanel.dataset.motionReady;
  });
}

const modal = document.getElementById("modal");
const modalSearchInput = document.getElementById("modal-search-input");
const modalList = document.getElementById("modal-list");
const sessionDeleteModal = document.getElementById("session-delete-modal");
const sessionDeleteDescription = document.getElementById("session-delete-description");
const sessionDeleteCancel = document.getElementById("session-delete-cancel");
const sessionDeleteConfirm = document.getElementById("session-delete-confirm");
const sessionDeleteVisibility = createVisibilityController(uiMotion, {
  root: sessionDeleteModal,
  surface: sessionDeleteModal.querySelector(".confirm-window"),
  openDuration: UI_MOTION.fast,
  surfaceOpenDuration: UI_MOTION.dialog,
  closeDuration: UI_MOTION.fast,
  surfaceCloseDuration: UI_MOTION.fast,
});
let modalMode = null;
let modalAllItems = [];
let modalItems = [];
let modalIndex = 0;
let modelCache = readPersistentModelCache();
let modelFetchPromise = null;
let pendingSessionDelete = null;
let deleteReturnFocus = null;
let modalCloseGeneration = 0;
const providerDiagnosticCache = new Map();
const MODEL_CACHE_TTL_MS = RUNTIME_PERFORMANCE_BUDGETS.modelCacheFreshMs;
const MODEL_CACHE_STALE_MS = RUNTIME_PERFORMANCE_BUDGETS.modelCacheStaleMs;

function readPersistentModelCache() {
  try { return parsePublicModelCache(localStorage.getItem(PUBLIC_MODEL_CACHE_KEY)); }
  catch (_) { return null; }
}

function persistPublicModelCache(cache) {
  if (!cache?.items?.length) return;
  try {
    localStorage.setItem(PUBLIC_MODEL_CACHE_KEY, JSON.stringify({
      items: publicModelCatalog(cache.items),
      expiresAt: cache.expiresAt,
      staleUntil: cache.staleUntil,
    }));
  } catch (_) {}
}
const modalSurface = modal.querySelector(".modal-window");
const modalVisibility = createVisibilityController(uiMotion, {
  root: modal,
  surface: modalSurface,
  openDuration: UI_MOTION.fast,
  surfaceOpenDuration: UI_MOTION.panel,
  closeDuration: UI_MOTION.fast,
  surfaceCloseDuration: UI_MOTION.fast,
});
const modalSelection = createSelectionController(uiMotion, {
  container: modalList,
  markerClass: "menu-selection-chevron modal-selection-chevron",
});
const modalInputOwner = createSelectionInputController(modalList);
let pendingModalActive = null;
const modalScrollScheduler = createFrameCoalescer(() => {
  const active = pendingModalActive;
  if (!active || !modalList.clientHeight) return;
  const top = active.offsetTop;
  const bottom = top + active.offsetHeight;
  if (top < modalList.scrollTop) modalList.scrollTop = top;
  else if (bottom > modalList.scrollTop + modalList.clientHeight) {
    modalList.scrollTop = bottom - modalList.clientHeight;
  }
});

function formatTokenCapacity(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}m ctx`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k ctx`;
  return `${value} ctx`;
}

function renderModelItem(model) {
  const el = document.createElement("div");
  el.className = "modal-item model-item";
  const name = document.createElement("span");
  name.className = "model-name";
  name.textContent = model.displayName || shortModelName(model.id);
  el.appendChild(name);
  el.title = model.id;
  el.setAttribute("aria-label", `${name.textContent}, ${model.providerName || "model"}`);
  return el;
}

function openModal(mode) {
  modalCloseGeneration++;
  modalMode = mode;
  modal.dataset.mode = mode;
  void modalVisibility.open();
  modalSearchInput.value = "";
  modalInputOwner.claimKeyboard();
  renderModalList(modalAllItems);
  revealMenuContent(modalSurface, ".modal-search", { delay: 42, distance: 7, maxItems: 1 });
  modalSearchInput.focus({ preventScroll: true });
  requestAnimationFrame(() => modalSearchInput.focus());
  updateModalActive();
}

function closeModal() {
  const generation = ++modalCloseGeneration;
  modalMode = null;
  modalItems = [];
  modalIndex = 0;
  void modalVisibility.close().then(() => {
    if (generation === modalCloseGeneration && modalMode === null) {
      modalSelection.reset();
      delete modal.dataset.mode;
    }
  });
  cmdInput.focus();
}

function renderModalList(items) {
  modalList.scrollTop = 0;
  modalList.innerHTML = "";
  modalItems = [];
  modalIndex = 0;
  if (modalMode === "models") {
    const groups = {};
    items.forEach((it) => {
      const key = it.providerName || "Modeller";
      if (!groups[key]) groups[key] = [];
      groups[key].push(it);
    });
    Object.keys(groups).sort((a, b) => a.localeCompare(b)).forEach((g) => {
      const header = document.createElement("div");
      header.className = "modal-category";
      header.textContent = `${g}  ${groups[g].length}`;
      modalList.appendChild(header);
      groups[g].slice(0, 80).forEach((it) => {
        const el = renderModelItem(it);
        modalList.appendChild(el);
        modalItems.push({ el, item: it });
      });
    });
  } else if (modalMode === "diagnostics-providers") {
    const header = document.createElement("div");
    header.className = "modal-category";
    header.textContent = "Provider to diagnose";
    modalList.appendChild(header);
    items.forEach((it) => {
      const el = document.createElement("div");
      el.className = "modal-item provider-item";
      const title = document.createElement("span");
      title.className = "provider-item-name";
      title.textContent = it.name;
      const meta = document.createElement("span");
      meta.className = "provider-item-state";
      const report = providerDiagnosticCache.get(it.id);
      meta.dataset.state = report?.overall || "unknown";
      meta.textContent = report ? diagnosticStateLabel(report.overall) : "Not checked yet";
      el.append(title, meta);
      modalList.appendChild(el);
      modalItems.push({ el, item: it });
    });
  } else if (modalMode === "sessions" || modalMode === "delete-sessions") {
    const header = document.createElement("div");
    header.className = "modal-category";
    header.textContent = modalMode === "delete-sessions" ? "Choose a conversation" : "Conversations";
    modalList.appendChild(header);
    items.forEach((it) => {
      const el = document.createElement("div");
      el.className = "modal-item session-item";
      const title = document.createElement("span");
      title.className = "session-title";
      title.textContent = it.title;
      const meta = document.createElement("span");
      meta.className = "session-meta";
      meta.textContent = shortModelName(it.model) + " · " + it.messageCount + (it.hasDraft ? " · draft" : "");
      el.append(title, meta);
      modalList.appendChild(el);
      modalItems.push({ el, item: it });
    });
  } else if (modalMode === "mode") {
    const header = document.createElement("div");
    header.className = "modal-category";
    header.textContent = "Access mode";
    modalList.appendChild(header);
    let connectedIdx = 0;
    items.forEach((it, i) => {
      const el = document.createElement("div");
      el.className = "modal-item";
      const isCurrent = configCache && configCache.mode === it.id;
      el.textContent = it.name + (isCurrent ? "  ✓" : "");
      if (isCurrent) connectedIdx = i;
      modalList.appendChild(el);
      modalItems.push({ el, item: it });
    });
    if (configCache) modalIndex = connectedIdx;
  } else {
    let connectedIdx = 0;
    const linked = (configCache && configCache.providers && configCache.providers.length > 0)
      ? configCache.providers.map((p) => p.id || p.provider)
      : (configCache && hasProviderCredential(configCache, PROVIDER_REGISTRY[configCache.provider]) ? [configCache.provider] : []);
    items.forEach((it, i) => {
      const el = document.createElement("div");
      el.className = "modal-item provider-item";
      const isConnected = linked.includes(it.id);
      const isActive = configCache && configCache.provider === it.id;
      const label = document.createElement("span");
      label.className = "provider-item-name";
      label.textContent = it.name;
      const indicator = document.createElement("span");
      indicator.className = "provider-health-indicator";
      const report = providerDiagnosticCache.get(it.id);
      indicator.dataset.state = report?.overall || (isConnected ? "connected" : "unlinked");
      indicator.setAttribute("aria-label", report
        ? diagnosticStateLabel(report.overall)
        : isConnected ? "Connected" : "Not connected");
      if (isActive) indicator.classList.add("is-active");
      el.append(label, indicator);
      if (isActive) connectedIdx = i;
      modalList.appendChild(el);
      modalItems.push({ el, item: it });
    });
    if (configCache) modalIndex = connectedIdx;
  }

  modalList.setAttribute("role", "listbox");
  modalItems.forEach((row, index) => {
    row.el.setAttribute("role", "option");
    row.el.addEventListener("mouseenter", () => {
      if (!modalInputOwner.acceptsPointer()) return;
      modalIndex = index;
      updateModalActive();
    });
    row.el.addEventListener("click", () => {
      modalInputOwner.claimPointer();
      modalIndex = index;
      void selectModalItem();
    });
  });
  const rows = modalItems.map((row) => row.el);
  modalSelection.setRows(rows);
  if (rows.length) modalSelection.moveTo(modalIndex, { immediate: true });
}

function updateModalActive() {
  const active = modalSelection.moveTo(modalIndex);
  if (!active) return;
  pendingModalActive = active;
  modalScrollScheduler.schedule();
}

function moveModalSelection(key) {
  if (!modalItems.length) return false;
  const visibleRows = Math.max(1, Math.floor(modalList.clientHeight / (modalItems[0]?.el.offsetHeight || 38)) - 1);
  if (key === "ArrowDown") modalIndex = (modalIndex + 1) % modalItems.length;
  else if (key === "ArrowUp") modalIndex = (modalIndex - 1 + modalItems.length) % modalItems.length;
  else if (key === "Home") modalIndex = 0;
  else if (key === "End") modalIndex = modalItems.length - 1;
  else if (key === "PageDown") modalIndex = Math.min(modalItems.length - 1, modalIndex + visibleRows);
  else if (key === "PageUp") modalIndex = Math.max(0, modalIndex - visibleRows);
  else return false;
  modalInputOwner.claimKeyboard();
  updateModalActive();
  return true;
}

function renderFilteredModal(items) {
  renderModalList(items);
  updateModalActive();
  void uiMotion.play(modalList, [
    { opacity: 0.82, transform: "translateY(1px)" },
    { opacity: 1, transform: "translateY(0)" },
  ], { duration: UI_MOTION.instant });
}

function transitionModalContent(mode, items, direction = 1) {
  modalCloseGeneration++;
  modalMode = mode;
  modal.dataset.mode = mode;
  modalSearchInput.value = "";
  modalInputOwner.claimKeyboard();
  renderModalList(items);
  updateModalActive();
  void uiMotion.play(modalList, [
    { opacity: 0.7, transform: `translateX(${direction * 6}px)` },
    { opacity: 1, transform: "translateX(0)" },
  ], { duration: UI_MOTION.fast });
  requestAnimationFrame(() => modalSearchInput.focus());
}

function filterModal() {
  const q = modalSearchInput.value.toLowerCase();
  if (!q) {
    renderFilteredModal(modalAllItems);
    return;
  }
  if (modalMode === "models") {
    const filtered = modalAllItems.filter((it) =>
      it.id.toLowerCase().includes(q)
      || (it.displayName || "").toLowerCase().includes(q)
      || (it.providerName || "").toLowerCase().includes(q)
    );
    renderFilteredModal(filtered);
  } else if (modalMode === "sessions" || modalMode === "delete-sessions") {
    const filtered = modalAllItems.filter((it) =>
      it.title.toLowerCase().includes(q) || it.model.toLowerCase().includes(q)
    );
    renderFilteredModal(filtered);
  } else if (modalMode === "diagnostics-providers") {
    const filtered = modalAllItems.filter((it) => it.name.toLowerCase().includes(q));
    renderFilteredModal(filtered);
  } else if (modalMode === "mode") {
    const filtered = modalAllItems.filter((it) => it.name.toLowerCase().includes(q));
    renderFilteredModal(filtered);
  } else {
    const filtered = Object.values(PROVIDER_REGISTRY)
      .filter((p) => p.name.toLowerCase().includes(q))
      .map((p) => ({ id: p.id, name: p.name, provider: p }));
    renderFilteredModal(filtered);
  }
}

async function selectModalItem() {
  const row = modalItems[modalIndex];
  if (!row) return;

  if (modalMode === "models") {
    await selectModel(row.item.providerId, row.item.id, row.item.displayName);
    closeModal();
  } else if (modalMode === "sessions") {
    const id = row.item.id;
    closeModal();
    await resumeSession(id);
  } else if (modalMode === "delete-sessions") {
    const session = row.item;
    closeModal();
    openSessionDeleteConfirm(session);
  } else if (modalMode === "diagnostics-providers") {
    const providerId = row.item.id;
    closeModal();
    await openProviderDiagnostics(providerId);
  } else if (modalMode === "mode") {
    const m = row.item.id;
    closeModal();
    if (!configCache) configCache = {};
    configCache.mode = m;
    persistConfigCache();
    try { await invoke("save_config", { config: configCache }); } catch (e) {}
    logLine("mod: " + m, "ok");
  } else if (modalMode === "providers") {
    const p = row.item.provider;
    const linked = (configCache && configCache.providers && configCache.providers.length > 0)
      ? configCache.providers
      : (configCache && hasProviderCredential(configCache, p) ? [configCache] : []);
    const existing = linked.find((lp) => (lp.id || lp.provider) === p.id);
    if (existing && hasProviderCredential(existing, p)) {
      closeModal();
      openApiModal(p, existing);
      return;
    }
    closeModal();
    openApiModal(p);
  }
}

document.addEventListener("keydown", (ev) => {
  if (!modalMode) return;
  if (ev.target === cmdInput) return;

  if (ev.target !== modalSearchInput) {
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey) {
      ev.preventDefault();
      modalSearchInput.value += ev.key;
      filterModal();
      return;
    }
    if (ev.key === "Backspace") {
      ev.preventDefault();
      modalSearchInput.value = modalSearchInput.value.slice(0, -1);
      filterModal();
      return;
    }
  }

  if (moveModalSelection(ev.key)) {
    ev.preventDefault();
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    selectModalItem();
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    closeModal();
  }
});

if (modalSearchInput) {
  modalSearchInput.addEventListener("keyup", (ev) => {
    if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp", "Enter", "Escape"].includes(ev.key)) return;
    filterModal();
  });
}

async function getModels(force = false, refreshBackend = force) {
  let config;
  try {
    config = configCache || (await invoke("get_config"));
  } catch (e) {
    logLine("Could not read config: " + e, "err");
    return [];
  }
  if (!config) {
    modelCache = null;
    try { localStorage.removeItem(PUBLIC_MODEL_CACHE_KEY); } catch (_) {}
    return [];
  }

  const allProviders = config.providers && config.providers.length > 0 ? config.providers : (config.provider ? [config] : []);
  const providers = allProviders.filter((p) => {
    const pMeta = PROVIDER_REGISTRY[p.id || p.provider];
    return hasProviderCredential(p, pMeta);
  });

  if (providers.length === 0) {
    modelCache = null;
    try { localStorage.removeItem(PUBLIC_MODEL_CACHE_KEY); } catch (_) {}
    return [];
  }

  const connectedIds = new Set(providers.map((p) => p.id || p.provider));

  if (!connectionOnline) {
    setConnectionOnline(false);
    return (modelCache?.items || []).filter((m) => connectedIds.has(m.providerId));
  }

  const cacheState = modelCacheState(modelCache);
  const cachedConnected = (modelCache?.items || []).filter((m) => connectedIds.has(m.providerId));
  if (!force && cacheState === "fresh" && cachedConnected.length > 0) return cachedConnected;
  if (!force && cacheState === "stale" && cachedConnected.length > 0) {
    if (!modelFetchPromise) {
      modelFetchPromise = getModels(true, true).finally(() => { modelFetchPromise = null; });
    }
    return cachedConnected;
  }
  const fallbackItems = cachedConnected;
  if (!force && modelFetchPromise) return modelFetchPromise;
  if (!force) {
    modelFetchPromise = getModels(true, false).finally(() => { modelFetchPromise = null; });
    return modelFetchPromise;
  }

  const failures = [];
  const requests = providers.map(async (p) => {
    const providerId = p.id || p.provider;
    try {
      const pConfig = {
        provider: providerId,
        baseUrl: p.baseUrl,
        model: p.model || "",
        protocol: p.protocol || null,
        authScheme: p.authScheme || null,
        secretRef: p.secretRef || null,
        modelsPath: p.modelsPath || null,
        chatPath: p.chatPath || null,
        headerNames: p.headerNames || [],
        requestTimeoutSecs: p.requestTimeoutSecs || null,
        allowLocalNetwork: Boolean(p.allowLocalNetwork),
        mode: config.mode || "smart",
        allowList: config.allowList || [],
      };
      countApiCall(); // list_models — API limitine dahil
      const models = await invoke("list_models", { config: pConfig, refresh: refreshBackend });
      setConnectionOnline(true);
      const pName = (PROVIDER_REGISTRY[providerId] || {}).name || providerId || "Provider";
      return models.map((model) => ({ ...model, providerId, providerName: pName }));
    } catch (e) {
      failures.push(String(e));
      logLine("Could not load model list (" + providerId + "): " + e, "err");
      return [];
    }
  });
  const all = (await Promise.all(requests)).flat();
  if (all.length > 0) {
    modelCache = {
      items: all,
      expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
      staleUntil: Date.now() + MODEL_CACHE_STALE_MS,
    };
    persistPublicModelCache(modelCache);
    if (modalMode === "models" && !modalSearchInput.value) {
      modalAllItems = all;
      renderModalList(all);
      updateModalActive();
    }
  }
  if (!all.length && failures.some(isNetworkFailure)) setConnectionOnline(false);
  return all.length ? all : fallbackItems;
}

async function selectModel(providerId, id, displayName = "") {
  const config = configCache || (await invoke("get_config"));
  if (!config) return;

  const providerEntry = (config.providers || []).find((p) => (p.id || p.provider) === providerId);
  if (providerEntry) {
    config.baseUrl = providerEntry.baseUrl;
    config.protocol = providerEntry.protocol || (PROVIDER_REGISTRY[providerId] || {}).protocol;
    config.authScheme = providerEntry.authScheme || (PROVIDER_REGISTRY[providerId] || {}).authScheme;
    config.secretRef = providerEntry.secretRef || null;
    config.modelsPath = providerEntry.modelsPath || null;
    config.chatPath = providerEntry.chatPath || null;
    config.headerNames = providerEntry.headerNames || [];
    config.requestTimeoutSecs = providerEntry.requestTimeoutSecs || null;
    config.allowLocalNetwork = Boolean(providerEntry.allowLocalNetwork);
    config.contextLimit = providerEntry.contextLimit ?? config.contextLimit ?? null;
    config.maxOutputTokens = providerEntry.maxOutputTokens ?? null;
    config.inputPricePerMillion = providerEntry.inputPricePerMillion ?? null;
    config.outputPricePerMillion = providerEntry.outputPricePerMillion ?? null;
    config.cachedInputPricePerMillion = providerEntry.cachedInputPricePerMillion ?? null;
  }

  config.provider = providerId;
  config.model = id;
  if (!config.providers || config.providers.length === 0) {
    config.providers = [{
      id: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      protocol: config.protocol,
      authScheme: config.authScheme,
      secretRef: config.secretRef,
      modelsPath: config.modelsPath,
      chatPath: config.chatPath,
      headerNames: config.headerNames || [],
      requestTimeoutSecs: config.requestTimeoutSecs,
      allowLocalNetwork: Boolean(config.allowLocalNetwork),
      contextLimit: config.contextLimit ?? null,
      maxOutputTokens: config.maxOutputTokens ?? null,
      inputPricePerMillion: config.inputPricePerMillion ?? null,
      outputPricePerMillion: config.outputPricePerMillion ?? null,
      cachedInputPricePerMillion: config.cachedInputPricePerMillion ?? null,
    }];
  }
  const target = config.providers.find((p) => (p.id || p.provider) === providerId);
  if (target) target.model = id;
  const selectedModel = modelCache && modelCache.items
    ? modelCache.items.find((model) => model.providerId === providerId && model.id === id)
    : null;
  if (selectedModel && selectedModel.contextWindow) config.contextLimit = selectedModel.contextWindow;
  if (selectedModel) {
    config.maxOutputTokens = selectedModel.maxOutputTokens ?? null;
    config.inputPricePerMillion = selectedModel.inputPricePerMillion ?? null;
    config.outputPricePerMillion = selectedModel.outputPricePerMillion ?? null;
    config.cachedInputPricePerMillion = selectedModel.cachedInputPricePerMillion ?? null;
    if (target) {
      target.contextLimit = selectedModel.contextWindow ?? config.contextLimit ?? null;
      target.maxOutputTokens = selectedModel.maxOutputTokens ?? null;
      target.inputPricePerMillion = selectedModel.inputPricePerMillion ?? null;
      target.outputPricePerMillion = selectedModel.outputPricePerMillion ?? null;
      target.cachedInputPricePerMillion = selectedModel.cachedInputPricePerMillion ?? null;
    }
  }
  await invoke("save_config", { config });
  configCache = config;
  persistConfigCache();
  updateModelChip(id, displayName || shortModelName(id));
  if (currentSession) await checkpointSession(currentSession.draft || null, currentSession.status || "active");
  const p = PROVIDER_REGISTRY[providerId];
  if (p) providerNameCache = p.name;
  cmdInput.focus();
}

async function openModelMenu() {
  hideSuggest();
  const transitionFromProviders = modalVisibility.visible && modalMode === "providers";
  let models = [];
  try {
    models = await getModels();
  } catch (e) {
    logLine("Could not load model list: " + e, "err");
  }
  if (models.length === 0) {
    try {
      const cfg = configCache || (await invoke("get_config"));
      if (cfg) {
        const allList = cfg.providers && cfg.providers.length > 0 ? cfg.providers : [cfg];
        const linkedList = allList.filter((p) => hasProviderCredential(p, PROVIDER_REGISTRY[p.id || p.provider]));
        for (const p of linkedList) {
          const pName = (PROVIDER_REGISTRY[p.id || p.provider] || {}).name || p.id || "Provider";
          const m = (p.id || p.provider) === cfg.provider ? cfg.model : p.model;
          if (m) {
            models.push({
              providerId: p.id || p.provider,
              providerName: pName,
              id: m,
              displayName: m,
              status: "current",
              recommended: false,
            });
          }
        }
        if (models.length) logLine("Network or rate-limit error — showing cached models", "sys");
      }
    } catch (e2) {}
  }
  if (models.length === 0) {
    showStatusToast("Please connect a provider first.");
    openProviderMenu();
    return;
  }
  modalAllItems = models;
  if (transitionFromProviders) transitionModalContent("models", models, 1);
  else openModal("models");
}

function openProviderMenu() {
  hideSuggest();
  modalAllItems = Object.values(PROVIDER_REGISTRY).map((p) => ({ id: p.id, name: p.name, provider: p }));
  openModal("providers");
}

function linkedProviderById(providerId) {
  const providers = configCache && Array.isArray(configCache.providers) ? configCache.providers : [];
  return providers.find((provider) => (provider.id || provider.provider) === providerId) || null;
}

function runtimeConfigForProvider(providerId) {
  const entry = linkedProviderById(providerId);
  if (!entry || !configCache) return null;
  return {
    ...configCache,
    provider: providerId,
    baseUrl: entry.baseUrl,
    model: entry.model,
    protocol: entry.protocol,
    authScheme: entry.authScheme,
    secretRef: entry.secretRef || null,
    modelsPath: entry.modelsPath || null,
    chatPath: entry.chatPath || null,
    headerNames: entry.headerNames || [],
    requestTimeoutSecs: entry.requestTimeoutSecs || null,
    allowLocalNetwork: Boolean(entry.allowLocalNetwork),
    contextLimit: entry.contextLimit ?? configCache.contextLimit ?? null,
    maxOutputTokens: entry.maxOutputTokens ?? null,
    inputPricePerMillion: entry.inputPricePerMillion ?? null,
    outputPricePerMillion: entry.outputPricePerMillion ?? null,
    cachedInputPricePerMillion: entry.cachedInputPricePerMillion ?? null,
  };
}

const diagnosticsModal = document.getElementById("diagnostics-modal");
const diagnosticsSurface = diagnosticsModal.querySelector(".diagnostics-window");
const diagnosticsProvider = document.getElementById("diagnostics-provider");
const diagnosticsTitle = document.getElementById("diagnostics-title");
const diagnosticsOverall = document.getElementById("diagnostics-overall");
const diagnosticsContent = document.getElementById("diagnostics-content");
const diagnosticsClose = document.getElementById("diagnostics-close");
const diagnosticsRefresh = document.getElementById("diagnostics-refresh");
const diagnosticsDeep = document.getElementById("diagnostics-deep");
const diagnosticsCopy = document.getElementById("diagnostics-copy");
const diagnosticsVisibility = createVisibilityController(uiMotion, {
  root: diagnosticsModal,
  surface: diagnosticsSurface,
  openDuration: UI_MOTION.fast,
  surfaceOpenDuration: UI_MOTION.dialog,
  closeDuration: UI_MOTION.fast,
  surfaceCloseDuration: UI_MOTION.fast,
});
let diagnosticsProviderId = null;
let diagnosticsReport = null;
let diagnosticsGeneration = 0;
let diagnosticsReturnFocus = null;
let diagnosticsBusy = false;

function diagnosticMeta(label, value) {
  const row = document.createElement("div");
  row.className = "diagnostics-meta-item";
  const key = document.createElement("span");
  key.textContent = label;
  const data = document.createElement("strong");
  data.textContent = value || "—";
  row.append(key, data);
  return row;
}

function diagnosticMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount);
}

function diagnosticCheckRow(entry) {
  const row = document.createElement("article");
  row.className = "diagnostics-check";
  row.dataset.state = entry.state || "unknown";
  const marker = document.createElement("span");
  marker.className = "diagnostics-check-marker";
  marker.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div");
  copy.className = "diagnostics-check-copy";
  const head = document.createElement("div");
  head.className = "diagnostics-check-head";
  const title = document.createElement("strong");
  title.textContent = entry.title || entry.id || "Check";
  const state = document.createElement("span");
  state.textContent = diagnosticStateLabel(entry.state);
  if (Number.isFinite(Number(entry.latencyMs))) state.textContent += ` · ${Math.round(Number(entry.latencyMs))} ms`;
  head.append(title, state);
  const detail = document.createElement("p");
  detail.textContent = entry.detail || "";
  copy.append(head, detail);
  if (entry.action) {
    const action = document.createElement("p");
    action.className = "diagnostics-check-action";
    action.textContent = entry.action;
    copy.appendChild(action);
  }
  row.append(marker, copy);
  return row;
}

function renderDiagnosticsLoading(providerId, deep) {
  const provider = PROVIDER_REGISTRY[providerId];
  diagnosticsProvider.textContent = provider?.name || providerId;
  diagnosticsTitle.textContent = deep ? "Deep connection test" : "Connection diagnostics";
  diagnosticsOverall.dataset.state = "checking";
  diagnosticsOverall.textContent = "Checking";
  diagnosticsContent.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "diagnostics-loading";
  for (const label of ["Credentials", "Model catalog", "Chat endpoint", "Tool support"]) {
    const line = document.createElement("span");
    line.textContent = label;
    loading.appendChild(line);
  }
  diagnosticsContent.appendChild(loading);
}

function renderDiagnostics(report) {
  diagnosticsProvider.textContent = report.providerName || report.providerId || "Provider";
  diagnosticsTitle.textContent = report.requestedModel ? shortModelName(report.requestedModel) : "Connection diagnostics";
  diagnosticsOverall.dataset.state = report.overall || "unknown";
  diagnosticsOverall.textContent = diagnosticStateLabel(report.overall);
  diagnosticsContent.innerHTML = "";

  const summary = document.createElement("section");
  summary.className = "diagnostics-summary";
  summary.append(
    diagnosticMeta("Endpoint", report.endpoint),
    diagnosticMeta("Protokol", report.protocol),
    diagnosticMeta("Catalog", report.modelCount === null || report.modelCount === undefined ? "—" : `${report.modelCount} models`),
  );
  diagnosticsContent.appendChild(summary);

  if (report.lastRequest) {
    const last = document.createElement("section");
    last.className = "diagnostics-last-request";
    const label = document.createElement("span");
    label.textContent = "Last request";
    const value = document.createElement("strong");
    value.textContent = `${lastRequestModel(report.lastRequest)} · ${report.lastRequest.latencyMs || 0} ms · ${statusNumber(report.lastRequest.totalTokens || 0)} token`;
    last.append(label, value);
    diagnosticsContent.appendChild(last);
  }

  const checks = document.createElement("section");
  checks.className = "diagnostics-checks";
  for (const entry of report.checks || []) checks.appendChild(diagnosticCheckRow(entry));
  diagnosticsContent.appendChild(checks);

  const limits = Object.entries(report.rateLimits || {}).filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (report.account || limits.length) {
    const limitSection = document.createElement("section");
    limitSection.className = "diagnostics-limits";
    const heading = document.createElement("span");
    heading.textContent = report.account ? "Account and provider limits" : "Provider limits";
    limitSection.appendChild(heading);
    if (report.account) {
      limitSection.append(
        diagnosticMeta("remaining credit", diagnosticMoney(report.account.remainingUsd)),
        diagnosticMeta("usage", diagnosticMoney(report.account.usageUsd)),
        diagnosticMeta("hesap", report.account.tier || "—"),
      );
    }
    for (const [key, value] of limits.slice(0, 6)) {
      limitSection.appendChild(diagnosticMeta(key.replace(/([A-Z])/g, " $1").toLowerCase(), String(value)));
    }
    diagnosticsContent.appendChild(limitSection);
  }

  revealMenuContent(diagnosticsModal, ".diagnostics-summary, .diagnostics-last-request, .diagnostics-check, .diagnostics-limits", {
    delay: 32,
    stagger: 18,
    maxItems: 12,
  });
}

function lastRequestModel(observation) {
  return shortModelName(observation.responseModel || observation.requestedModel || "model");
}

function diagnosticObservation(providerId) {
  const observation = currentSession?.usage?.lastRequest || null;
  return observation?.provider === providerId ? observation : null;
}

function setDiagnosticsBusy(value) {
  diagnosticsBusy = value;
  diagnosticsContent?.setAttribute("aria-busy", value ? "true" : "false");
  diagnosticsRefresh.disabled = value;
  diagnosticsDeep.disabled = value;
  diagnosticsCopy.disabled = value || !diagnosticsReport;
}

async function runProviderDiagnostics(providerId, deep = false) {
  const config = runtimeConfigForProvider(providerId);
  if (!config) throw new Error("Provider is not connected");
  const generation = ++diagnosticsGeneration;
  setDiagnosticsBusy(true);
  renderDiagnosticsLoading(providerId, deep);
  try {
    const nativeReport = await invoke("diagnose_provider", { config, deep });
    if (generation !== diagnosticsGeneration || diagnosticsProviderId !== providerId) return null;
    diagnosticsReport = mergeDiagnosticReport(nativeReport, diagnosticObservation(providerId));
    providerDiagnosticCache.set(providerId, diagnosticsReport);
    renderDiagnostics(diagnosticsReport);
    return diagnosticsReport;
  } catch (error) {
    if (generation !== diagnosticsGeneration) return null;
    diagnosticsReport = mergeDiagnosticReport({
      providerId,
      providerName: PROVIDER_REGISTRY[providerId]?.name || providerId,
      overall: "failed",
      endpoint: "",
      protocol: config.protocol,
      requestedModel: config.model,
      checks: [{
        id: "runtime",
        title: "Diagnostics engine",
        state: "failed",
        detail: safeError(error),
        action: "Reconnect the provider and try again.",
      }],
    }, diagnosticObservation(providerId));
    providerDiagnosticCache.set(providerId, diagnosticsReport);
    renderDiagnostics(diagnosticsReport);
    return diagnosticsReport;
  } finally {
    if (generation === diagnosticsGeneration) setDiagnosticsBusy(false);
  }
}

async function openProviderDiagnostics(providerId) {
  if (!runtimeConfigForProvider(providerId)) {
    showStatusToast("This provider is not connected.");
    return;
  }
  diagnosticsProviderId = providerId;
  diagnosticsReport = providerDiagnosticCache.get(providerId) || null;
  diagnosticsReturnFocus = document.activeElement;
  void diagnosticsVisibility.open();
  if (diagnosticsReport) renderDiagnostics(mergeDiagnosticReport(diagnosticsReport, diagnosticObservation(providerId)));
  else renderDiagnosticsLoading(providerId, false);
  revealMenuContent(diagnosticsModal, ".diagnostics-header, .diagnostics-actions", { delay: 38, stagger: 24, maxItems: 2 });
  requestAnimationFrame(() => diagnosticsClose.focus());
  await runProviderDiagnostics(providerId, false);
}

async function openDiagnosticsMenu() {
  hideSuggest();
  const linked = (configCache?.providers || []).filter((entry) => hasProviderCredential(entry, PROVIDER_REGISTRY[entry.id || entry.provider]));
  if (!linked.length && configCache?.provider && hasProviderCredential(configCache, PROVIDER_REGISTRY[configCache.provider])) {
    linked.push(configCache);
  }
  const unique = [...new Map(linked.map((entry) => {
    const id = entry.id || entry.provider;
    return [id, { id, name: PROVIDER_REGISTRY[id]?.name || id }];
  })).values()];
  if (!unique.length) {
    showStatusToast("Connect a provider first.");
    return;
  }
  if (unique.length === 1) {
    await openProviderDiagnostics(unique[0].id);
    return;
  }
  modalAllItems = unique;
  openModal("diagnostics-providers");
}

function closeProviderDiagnostics() {
  if (!diagnosticsVisibility.visible) return;
  diagnosticsGeneration++;
  void diagnosticsVisibility.close();
  diagnosticsProviderId = null;
  setDiagnosticsBusy(false);
  const target = diagnosticsReturnFocus?.isConnected ? diagnosticsReturnFocus : cmdInput;
  diagnosticsReturnFocus = null;
  target.focus();
}

async function copyProviderDiagnostics() {
  if (!diagnosticsReport) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(diagnosticExport(diagnosticsReport), null, 2));
    showStatusToast("Safe diagnostics report copied.");
  } catch (error) {
    showStatusToast("Could not copy report to the clipboard.");
  }
}

diagnosticsClose?.addEventListener("click", closeProviderDiagnostics);
diagnosticsRefresh?.addEventListener("click", () => {
  if (!diagnosticsBusy && diagnosticsProviderId) void runProviderDiagnostics(diagnosticsProviderId, false);
});
diagnosticsDeep?.addEventListener("click", () => {
  if (!diagnosticsBusy && diagnosticsProviderId) void runProviderDiagnostics(diagnosticsProviderId, true);
});
diagnosticsCopy?.addEventListener("click", () => void copyProviderDiagnostics());
diagnosticsModal?.addEventListener("click", (event) => {
  if (event.target === diagnosticsModal) closeProviderDiagnostics();
});
document.addEventListener("keydown", (event) => {
  if (!diagnosticsVisibility.visible) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeProviderDiagnostics();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    const controls = [diagnosticsRefresh, diagnosticsDeep, diagnosticsCopy, diagnosticsClose]
      .filter((control) => control && !control.disabled);
    if (!controls.length) return;
    const current = controls.indexOf(document.activeElement);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = current < 0
      ? controls[0]
      : controls[(current + direction + controls.length) % controls.length];
    event.preventDefault();
    event.stopPropagation();
    next.focus({ preventScroll: true });
  }
}, true);

async function testLinkedProvider(providerId) {
  const config = runtimeConfigForProvider(providerId);
  if (!config) throw new Error("Provider is not connected");
  countApiCall();
  const result = await invoke("test_provider_connection", { config });
  logLine(`${providerId}: ${result.message}`, "ok");
  return result;
}

async function reconnectProvider(providerId) {
  const entry = linkedProviderById(providerId);
  const provider = PROVIDER_REGISTRY[providerId];
  if (!provider) throw new Error("Provider was not found");
  openApiModal({ ...provider, ...(entry || {}), id: providerId, name: provider.name });
}

async function removeLinkedProvider(providerId) {
  const updated = await invoke("disconnect_provider", { providerId });
  configCache = upgradeProviderConfig(updated);
  modelCache = null;
  providerNameCache = configCache && PROVIDER_REGISTRY[configCache.provider]
    ? PROVIDER_REGISTRY[configCache.provider].name
    : null;
  persistConfigCache();
  if (configCache && configCache.model) updateModelChip(configCache.model);
  logLine(`${providerId}: connection and secure credentials removed`, "ok");
  if (!configCache || !configCache.provider) openProviderMenu();
}

function openModeMenu() {
  hideSuggest();
  modalAllItems = [
    { id: "smart", name: "smart — reads automatically; writes and risky actions require approval" },
    { id: "strict", name: "strict — every action requires approval" },
    { id: "autonomous", name: "autonomous — fully autonomous, no approvals" },
  ];
  openModal("mode");
}

async function openSessionsMenu() {
  modalAllItems = await invoke("list_sessions");
  openModal("sessions");
}

async function openDeleteSessionsMenu() {
  if (activeRequestId) {
    renderAlert("A conversation cannot be deleted while a response is active.");
    return;
  }
  modalAllItems = await invoke("list_sessions");
  if (!modalAllItems.length) {
    showStatusToast("There are no conversations to delete.");
    return;
  }
  openModal("delete-sessions");
}

function openSessionDeleteConfirm(session) {
  pendingSessionDelete = session;
  deleteReturnFocus = document.activeElement;
  sessionDeleteDescription.textContent = `“${session.title}” will be permanently deleted. This cannot be undone.`;
  void sessionDeleteVisibility.open();
  revealMenuContent(sessionDeleteModal, ".confirm-copy, .confirm-actions", { delay: 55, stagger: 30, maxItems: 2 });
  requestAnimationFrame(() => sessionDeleteCancel.focus());
}

function closeSessionDeleteConfirm() {
  void sessionDeleteVisibility.close();
  pendingSessionDelete = null;
  const target = deleteReturnFocus;
  deleteReturnFocus = null;
  if (target && typeof target.focus === "function" && target.isConnected) target.focus();
  else cmdInput.focus();
}

async function confirmSessionDelete() {
  const session = pendingSessionDelete;
  if (!session) return;
  sessionDeleteConfirm.disabled = true;
  try {
    const deleted = await invoke("delete_session", { id: session.id });
    closeSessionDeleteConfirm();
    if (!deleted) {
      showStatusToast("The conversation has already been deleted.");
      return;
    }
    if (currentSession?.id === session.id) await newSession();
    showStatusToast(`“${session.title}” deleted · cannot be undone`);
  } catch (error) {
    renderAlert("Could not delete conversation: " + safeError(error));
  } finally {
    sessionDeleteConfirm.disabled = false;
  }
}

sessionDeleteCancel?.addEventListener("click", closeSessionDeleteConfirm);
sessionDeleteConfirm?.addEventListener("click", () => void confirmSessionDelete());
sessionDeleteModal?.addEventListener("click", (event) => {
  if (event.target === sessionDeleteModal) closeSessionDeleteConfirm();
});

document.addEventListener("keydown", (event) => {
  if (!sessionDeleteModal || sessionDeleteModal.style.display === "none") return;
  const controls = [sessionDeleteCancel, sessionDeleteConfirm];
  const current = Math.max(0, controls.indexOf(document.activeElement));
  if (event.key === "Escape") {
    event.preventDefault();
    closeSessionDeleteConfirm();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    controls[(current + (event.key === "ArrowRight" ? 1 : -1) + controls.length) % controls.length].focus();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (document.activeElement === sessionDeleteConfirm) void confirmSessionDelete();
    else closeSessionDeleteConfirm();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    controls[(current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
  }
}, true);

// ===== AUTCOMPLETE =====
async function updateSuggestions() {
  if (suggestMode === "models" || suggestMode === "providers" || suggestMode === "mode") return;
  const v = cmdInput.value.trim();
  if (!v) { hideSuggest(); return; }
  if (!v.startsWith("/")) { hideSuggest(); return; }
  const lower = v.toLowerCase();
  if (COMMANDS.includes(lower)) { hideSuggest(); return; }
  const matches = COMMANDS.filter((c) => c.startsWith(lower) && c !== lower).sort();
  if (matches.length > 0) showSuggest(matches, "commands");
  else hideSuggest();
}

const cmdInput = document.getElementById("cmd-input");
const streamStop = document.getElementById("stream-stop");
const streamActions = document.getElementById("stream-actions");
let cmdHistory = [];
let historyIdx = -1;
let conversationHistory = [];
let currentSession = null;
let activeRequestId = null;
let activeStreamRenderer = null;
let lastStreamSequence = 0;
let checkpointTimer = null;
let sessionSaveChain = Promise.resolve();

function requestId() {
  return "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function sessionTitle(text) {
  return String(text || "").trim().replace(/\s+/g, " ").slice(0, 64) || "New conversation";
}

async function ensureSession(firstMessage) {
  if (currentSession) return currentSession;
  currentSession = await invoke("create_session", {
    title: sessionTitle(firstMessage),
    provider: configCache?.provider || "",
    model: configCache?.model || "",
    workspace: WORKSPACE_DIR || "",
  });
  normalizeSessionIntelligence(currentSession);
  return currentSession;
}

async function checkpointSession(draft = null, status = "active") {
  if (!currentSession) return;
  normalizeSessionIntelligence(currentSession);
  currentSession.messages = conversationHistory;
  currentSession.draft = draft;
  currentSession.status = status;
  currentSession.provider = configCache?.provider || currentSession.provider;
  currentSession.model = configCache?.model || currentSession.model;
  currentSession.contextLimit = configCache?.contextLimit ?? currentSession.contextLimit ?? null;
  currentSession.contextRatio = configCache?.contextRatio ?? currentSession.contextRatio ?? null;
  currentSession.compaction.threshold = contextRatioOf(configCache);
  currentSession.workspace = WORKSPACE_DIR || currentSession.workspace;
  const snapshot = JSON.parse(JSON.stringify(currentSession));
  sessionSaveChain = sessionSaveChain.catch(() => {}).then(async () => {
    const saved = await invoke("save_session", { session: snapshot });
    if (currentSession?.id === saved.id && currentSession.status === snapshot.status) {
      currentSession.updatedAt = saved.updatedAt;
    }
    return saved;
  });
  return sessionSaveChain;
}

function scheduleDraftCheckpoint(draft) {
  if (checkpointTimer) return;
  checkpointTimer = setTimeout(async () => {
    checkpointTimer = null;
    try { await checkpointSession(draft, "interrupted"); } catch (e) {}
  }, 2000);
}

function compactionBoundary(mode = "auto") {
  if (!currentSession) return null;
  normalizeSessionIntelligence(currentSession);
  const through = Math.max(0, Number(currentSession.compaction.compactedThrough || 0));
  const userStarts = [];
  for (let index = through; index < conversationHistory.length; index++) {
    if (conversationHistory[index]?.role === "user") userStarts.push(index);
  }
  const keepUserTurns = mode === "auto" ? 4 : 1;
  if (userStarts.length <= keepUserTurns) return null;
  const boundary = userStarts[userStarts.length - keepUserTurns];
  return boundary > through ? boundary : null;
}

function serializeCompactionMessages(messages) {
  return messages.map((message, index) => {
    const lines = [`[${index + 1}] role=${message.role}`];
    if (message.toolCallId) lines.push(`toolCallId=${message.toolCallId}`);
    if (message.toolCalls?.length) lines.push("toolCalls=" + JSON.stringify(message.toolCalls));
    if (message.content) lines.push(String(message.content));
    if (message.reasoningContent) lines.push("reasoning=" + String(message.reasoningContent));
    return lines.join("\n");
  }).join("\n\n---\n\n");
}

function compactionPrompt(previousSummary, messages) {
  return (
    "Update the older session context below for another AI that must continue the same work without interruption. " +
    "Do not call tools; return only a structured English summary. If a prior summary exists, preserve its details and merge new information into the relevant sections. " +
    "Preserve file paths, function and variable names, error text, numbers, and user constraints exactly. " +
    "Record the relationship between tool calls and their results; do not invent details.\n\n" +
    "REQUIRED SECTIONS:\n" +
    "## Session Objective\n## User Constraints\n## Decisions\n## Files and Artifacts\n" +
    "## Tool Results\n## Current State\n## Open Work and Next Steps\n\n" +
    "PREVIOUS ANCHORED SUMMARY:\n" + (previousSummary || "(first compaction)") +
    "\n\nNEW MESSAGES TO COMPACT:\n" + serializeCompactionMessages(messages)
  );
}

async function performCompaction(mode = "manual", homeDir = "") {
  if (!currentSession) return { compacted: false, reason: "Start a session first." };
  normalizeSessionIntelligence(currentSession);
  const boundary = compactionBoundary(mode);
  if (boundary === null) {
    return { compacted: false, reason: "There are not enough older conversation turns to compact." };
  }

  const previousCompaction = JSON.parse(JSON.stringify(currentSession.compaction));
  const previousUsage = JSON.parse(JSON.stringify(currentSession.usage));
  const previousThrough = Number(previousCompaction.compactedThrough || 0);
  const span = conversationHistory.slice(previousThrough, boundary);
  const beforeHistory = effectiveRequestHistory(configCache, homeDir);
  const tokensBefore = estimateTokens(beforeHistory);
  const summaryRequest = [
    {
      role: "system",
      content: "You are a loss-aware context compactor. Never call tools. Preserve exact technical identifiers and output only the requested structured summary.",
    },
    { role: "user", content: compactionPrompt(previousCompaction.summary, span) },
  ];

  currentSession.messages = conversationHistory;
  const checkpoint = JSON.parse(JSON.stringify(currentSession));
  await invoke("checkpoint_session", { session: checkpoint });

  try {
    countApiCall();
    const reply = await invoke("chat_completion", { config: configCache, messages: summaryRequest });
    const summary = String(reply?.text || "").trim();
    if (!summary) throw new Error("The provider did not return a valid compaction summary");

    currentSession.compaction = {
      ...previousCompaction,
      autoEnabled: true,
      threshold: contextRatioOf(configCache),
      summary,
      compactedThrough: boundary,
      count: Number(previousCompaction.count || 0) + 1,
      lastAt: Date.now(),
      lastMode: mode,
      tokensBefore,
    };
    const tokensAfter = estimateTokens(effectiveRequestHistory(configCache, homeDir));
    if (tokensAfter >= tokensBefore) {
      throw new Error("The compacted summary was not smaller than the current context; history was left unchanged");
    }
    recordReplyUsage(reply, summaryRequest, { updateContext: false });
    currentSession.compaction.tokensAfter = tokensAfter;
    currentSession.compaction.tokensSaved = Math.max(0, tokensBefore - tokensAfter);
    currentSession.usage.currentContextTokens = tokensAfter;
    await checkpointSession(null, currentSession.status || "active");
    updateCtxGauge(effectiveConversationHistory(), null);
    return {
      compacted: true,
      before: tokensBefore,
      after: tokensAfter,
      saved: currentSession.compaction.tokensSaved,
      boundary,
    };
  } catch (error) {
    currentSession.compaction = previousCompaction;
    currentSession.usage = previousUsage;
    throw error;
  }
}

function shouldAutoCompact(history) {
  if (!currentSession) return false;
  normalizeSessionIntelligence(currentSession);
  if (!currentSession.compaction.autoEnabled) return false;
  const used = Math.max(
    estimateTokens(history || effectiveRequestHistory(configCache, "")),
    Number(currentSession.usage.currentContextTokens || 0),
  );
  return used >= compactThresholdFor(configCache) && compactionBoundary("auto") !== null;
}

function formatUsd(value) {
  if (value === null || value === undefined || value === "") return "provider does not report pricing";
  const number = Number(value);
  if (!Number.isFinite(number)) return "provider does not report pricing";
  if (number < 0.01) return "$" + number.toFixed(5);
  return "$" + number.toFixed(3);
}

const statusModal = document.getElementById("status-modal");
const statusProvider = document.getElementById("status-provider");
const statusTitle = document.getElementById("status-title");
const statusContent = document.getElementById("status-content");
const statusClose = document.getElementById("status-close");
const statusVisibility = createVisibilityController(uiMotion, {
  root: statusModal,
  surface: statusModal.querySelector(".status-window"),
  openDuration: UI_MOTION.fast,
  surfaceOpenDuration: UI_MOTION.dialog,
  closeDuration: UI_MOTION.fast,
  surfaceCloseDuration: UI_MOTION.fast,
});
let statusReturnFocus = null;

function statusMetric(label, value, emphasis = false) {
  const row = document.createElement("div");
  row.className = "status-metric" + (emphasis ? " emphasis" : "");
  const key = document.createElement("span");
  key.className = "status-metric-label";
  key.textContent = label;
  const data = document.createElement("span");
  data.className = "status-metric-value";
  data.textContent = value;
  row.append(key, data);
  return row;
}

function statusSection(title, rows) {
  const section = document.createElement("section");
  section.className = "status-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.appendChild(heading);
  rows.forEach((row) => section.appendChild(row));
  return section;
}

function limitSnapshot(remaining, limit, reset) {
  const hasRemaining = remaining !== null && remaining !== undefined && remaining !== "";
  const hasLimit = limit !== null && limit !== undefined && limit !== "";
  const hasReset = reset !== null && reset !== undefined && reset !== "";
  if (!hasRemaining && !hasLimit && !hasReset) return "";
  let value = hasRemaining && hasLimit
    ? `${remaining} / ${limit}`
    : hasRemaining
      ? `${remaining} remaining`
      : hasLimit
        ? `limit ${limit}`
        : "";
  if (hasReset) value += `${value ? " · " : ""}${reset}`;
  return value;
}

function statusNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "—");
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}m`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}k`;
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function rateLimitCandidates(rate) {
  return [
    ["requests", "Requests", rate.requestsRemaining, rate.requestsLimit, rate.requestsReset],
    ["tokens", "Token", rate.tokensRemaining, rate.tokensLimit, rate.tokensReset],
    ["input", "Input", rate.inputTokensRemaining, rate.inputTokensLimit, rate.inputTokensReset],
    ["output", "Output", rate.outputTokensRemaining, rate.outputTokensLimit, rate.outputTokensReset],
    ["cached", "Cache input", rate.cachedInputTokensRemaining, rate.cachedInputTokensLimit, rate.cachedInputTokensReset],
    ["project", "Project tokens", rate.projectTokensRemaining, rate.projectTokensLimit, rate.projectTokensReset],
  ];
}

function rateLimitMetrics(rate, omittedKey = "") {
  const rows = rateLimitCandidates(rate)
    .filter(([key]) => key !== omittedKey)
    .map(([, label, remaining, limit, reset]) => [label, limitSnapshot(remaining, limit, reset)])
    .filter(([, value]) => value)
    .map(([label, value]) => statusMetric(label, value));
  if (rate.retryAfter) rows.push(statusMetric("Retry after", String(rate.retryAfter)));
  return rows;
}

function statusHero(rate, usage, context) {
  for (const [key, label, remaining, limit, reset] of rateLimitCandidates(rate)) {
    if (remaining !== null && remaining !== undefined && remaining !== "") {
      const limitValue = Number(limit);
      const remainingValue = Number(remaining);
      return {
        key,
        label: `${label.toLocaleLowerCase("en-US")} remaining`,
        value: statusNumber(remaining),
        detail: `${limit ? `/ ${statusNumber(limit)}` : ""}${reset ? ` · ${reset}` : ""}`.trim(),
        progress: Number.isFinite(limitValue) && limitValue > 0 && Number.isFinite(remainingValue)
          ? Math.max(0, Math.min(100, (remainingValue / limitValue) * 100))
          : context.percent,
      };
    }
  }

  for (const [key, label, , limit, reset] of rateLimitCandidates(rate)) {
    if (limit !== null && limit !== undefined && limit !== "") {
      return {
        key,
        label: `${label.toLocaleLowerCase("en-US")} limit`,
        value: statusNumber(limit),
        detail: reset ? String(reset) : "provider limit",
        progress: context.percent,
      };
    }
  }

  if (Number(usage.totalTokens) > 0) {
    return {
      key: "usage",
      label: "tokens used",
      value: statusNumber(usage.totalTokens),
      detail: `${statusNumber(usage.inputTokens)} input · ${statusNumber(usage.outputTokens)} output`,
      progress: context.percent,
    };
  }

  return {
    key: "context",
    label: "context usage",
    value: `%${context.percent.toFixed(1)}`,
    detail: `${statusNumber(context.used)} / ${statusNumber(context.limit)} · ${context.source}`,
    progress: context.percent,
  };
}

function renderSessionStatus() {
  const usage = currentSession ? normalizeSessionIntelligence(currentSession).usage : defaultSessionUsage();
  const limit = contextLimitOf(configCache);
  const used = currentContextTokens(effectiveConversationHistory());
  const remaining = Math.max(0, limit - used);
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const source = usage.source || "estimated";
  const rate = usage.rateLimits || {};
  const hero = statusHero(rate, usage, { limit, used, remaining, percent, source });
  const rateRows = rateLimitMetrics(rate, hero.key);

  statusProvider.textContent = providerNameCache || configCache?.provider || "Session";
  statusTitle.textContent = shortModelName(configCache?.model || "model");
  statusContent.innerHTML = "";

  const heroSection = document.createElement("section");
  heroSection.className = "status-hero";
  const heroLabel = document.createElement("span");
  heroLabel.className = "status-hero-label";
  heroLabel.textContent = hero.label;
  const heroTop = document.createElement("div");
  heroTop.className = "status-hero-top";
  const heroValue = document.createElement("strong");
  heroValue.textContent = hero.value;
  const heroDetail = document.createElement("span");
  heroDetail.textContent = hero.detail;
  heroTop.append(heroValue, heroDetail);
  const track = document.createElement("div");
  track.className = "status-hero-track";
  const fill = document.createElement("span");
  fill.style.setProperty("--status-progress", `${hero.progress}%`);
  track.appendChild(fill);
  heroSection.append(heroLabel, heroTop, track);

  statusContent.append(
    heroSection,
    statusSection("Session", [
      statusMetric("Context", `${statusNumber(used)} / ${statusNumber(limit)} · %${percent.toFixed(1)}`, hero.key === "context"),
      statusMetric("Input / output", `${statusNumber(usage.inputTokens)} / ${statusNumber(usage.outputTokens)}`),
      statusMetric("Reasoning / cached", `${statusNumber(usage.reasoningTokens)} / ${statusNumber(usage.cachedTokens)}`),
      statusMetric("API / cost", `${usage.apiCalls} calls · ${formatUsd(usage.costUsd)}`),
    ]),
  );
  if (rateRows.length) statusContent.appendChild(statusSection("Limits", rateRows));

  statusReturnFocus = document.activeElement;
  void statusVisibility.open();
  revealMenuContent(statusModal, ".status-header, .status-hero, .status-section", {
    delay: 52,
    stagger: 26,
    maxItems: 8,
  });
  requestAnimationFrame(() => statusClose.focus());
}

function closeSessionStatus() {
  if (!statusModal || statusModal.style.display === "none") return;
  void statusVisibility.close();
  const target = statusReturnFocus && typeof statusReturnFocus.focus === "function" ? statusReturnFocus : cmdInput;
  target.focus();
  statusReturnFocus = null;
}

statusClose?.addEventListener("click", closeSessionStatus);
statusModal?.addEventListener("click", (event) => {
  if (event.target === statusModal) closeSessionStatus();
});
document.addEventListener("keydown", (event) => {
  if (!statusModal || statusModal.style.display === "none") return;
  if (event.key === "Escape" || event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    closeSessionStatus();
  }
}, true);

async function generateSmartSessionTitle(userMessage, assistantText) {
  if (!currentSession || currentSession.titleGenerated) return;
  const userTurns = conversationHistory.filter((message) => message.role === "user").length;
  if (userTurns !== 1 || !assistantText.trim()) return;
  const sessionId = currentSession.id;
  currentSession.titleGenerated = true;
  try {
    countApiCall();
    const title = await invoke("generate_session_title", {
      config: configCache,
      userMessage,
      assistantText,
    });
    if (currentSession?.id !== sessionId) return;
    currentSession.title = sessionTitle(title);
    await checkpointSession(currentSession.draft || null, currentSession.status || "complete");
  } catch (error) {
    if (currentSession?.id === sessionId) {
      currentSession.titleGenerated = false;
      try { await checkpointSession(currentSession.draft || null, currentSession.status || "complete"); } catch (saveError) {}
    }
  }
}

function renderSession(record) {
  logEl.innerHTML = "";
  const fragment = document.createDocumentFragment();
  logRenderTarget = fragment;
  const savedToolCalls = new Map();
  try {
    for (const message of record.messages || []) {
      if (message.role === "user") userBlock(message.content || "");
      else if (message.role === "assistant") {
        for (const call of message.toolCalls || []) savedToolCalls.set(call.id, call);
        if (message.content) completedRichMessage(message.content, (message.toolCalls || []).length ? "ai-step complete" : "assistant-response");
      }
      else if (message.role === "tool") {
        const content = String(message.content || "");
        const match = content.match(/^\[tool:([^\]]+)]\s*/);
        const savedCall = savedToolCalls.get(message.toolCallId);
        const toolName = savedCall?.name || match?.[1] || "tool result";
        const params = savedCall?.arguments && typeof savedCall.arguments === "object" ? savedCall.arguments : {};
        const target = toolName === "execute_command"
          ? String(params.command || params.cmd || "").slice(0, 60)
          : shortPath(params.path || params.url || params.pattern || "").slice(0, 60);
        const restoredItem = logItem(toolName, {
          status: "ok",
          toolName,
          target,
          bodyText: content.slice(match?.[0]?.length || 0),
        });
        restoredItem.setStatus("ok");
      }
    }
    if (record.draft?.text) {
      const partial = completedRichMessage(record.draft.text);
      partial.classList.add("interrupted-response");
      partial.title = "This response was interrupted before completion and was not added to provider history.";
    }
  } finally {
    logRenderTarget = logEl;
  }
  logEl.appendChild(fragment);
  updateCtxGauge(conversationHistory, null);
}

async function resumeSession(id) {
  if (activeRequestId) throw new Error("Cannot switch sessions while a response is active");
  const record = await invoke("load_session", { id });
  const restored = runtimeConfigForProvider(record.provider);
  if (restored) {
    configCache = {
      ...restored,
      model: record.model || restored.model,
      contextLimit: record.contextLimit ?? restored.contextLimit,
      contextRatio: record.contextRatio ?? restored.contextRatio,
    };
    const providerEntry = linkedProviderById(record.provider);
    if (providerEntry && record.model) providerEntry.model = record.model;
    await invoke("save_config", { config: configCache });
    persistConfigCache();
    providerNameCache = PROVIDER_REGISTRY[record.provider]?.name || record.provider;
  } else if (configCache && record.provider === configCache.provider) {
    configCache.model = record.model || configCache.model;
    configCache.contextLimit = record.contextLimit ?? configCache.contextLimit;
    configCache.contextRatio = record.contextRatio ?? configCache.contextRatio;
    await invoke("save_config", { config: configCache });
    persistConfigCache();
  }
  currentSession = normalizeSessionIntelligence(record);
  conversationHistory = Array.isArray(record.messages) ? record.messages : [];
  apiCallCount = Number(currentSession.usage.apiCalls || 0);
  updateModelChip(record.model || configCache?.model || "model");
  renderSession(record);
}

async function newSession() {
  if (activeRequestId) await stopActiveStream();
  currentSession = null;
  conversationHistory = [];
  logEl.innerHTML = "";
  updateCtxGauge([], null);
  cmdInput.focus();
}

async function stopActiveStream() {
  if (!activeRequestId) return false;
  const id = activeRequestId;
  try { return await invoke("cancel_chat_stream", { requestId: id }); }
  catch (error) { renderAlert("durdurma: " + safeError(error)); return false; }
}

if (streamStop) streamStop.addEventListener("click", stopActiveStream);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !activeRequestId) return;
  event.preventDefault();
  event.stopPropagation();
  void stopActiveStream();
}, true);

if (cmdInput) {
  cmdInput.addEventListener("keydown", async (ev) => {
    if (suggestMode === "models" || suggestMode === "providers" || suggestMode === "mode") {
      if (moveSuggestSelection(ev.key)) {
        ev.preventDefault();
        return;
      }
      if (ev.key === "Enter") { ev.preventDefault(); await applySuggest(suggestIndex); return; }
      if (ev.key === "Escape") { ev.preventDefault(); hideSuggest(); return; }
      if (ev.key.length === 1) hideSuggest();
    }

    if (suggestMode === "commands") {
      if (moveSuggestSelection(ev.key)) {
        ev.preventDefault();
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        const typed = cmdInput.value.trim().toLowerCase();
        const item = suggestItems[suggestIndex];
        hideSuggest();
        if (typed.startsWith("/") && COMMANDS.includes(typed)) {
          cmdInput.value = "";
          await runCommand(typed);
          return;
        }
        if (item) {
          cmdInput.value = "";
          if (item.startsWith("/")) await runCommand(item);
        }
        return;
      }
      if (ev.key === "Escape") { ev.preventDefault(); hideSuggest(); return; }
    }

    if (ev.key === "Enter") {
      ev.preventDefault();
      const cmd = cmdInput.value;
      if (cmd.trim() === "") return;

      if (cmd.trim().startsWith("/")) {
        cmdHistory.push(cmd);
        historyIdx = -1;
        followOutput = true;
        hideSuggest();
        await runCommand(cmd);
        cmdInput.value = "";
      } else {
        cmdHistory.push(cmd);
        historyIdx = -1;
        followOutput = true;
        userBlock(cmd);
        cmdInput.value = "";
        await sendChat(cmd);
      }
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (cmdHistory.length > 0) {
        if (historyIdx === -1) historyIdx = cmdHistory.length - 1;
        else if (historyIdx > 0) historyIdx--;
        cmdInput.value = cmdHistory[historyIdx] || "";
      }
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (historyIdx !== -1) {
        if (historyIdx < cmdHistory.length - 1) { historyIdx++; cmdInput.value = cmdHistory[historyIdx] || ""; }
        else { historyIdx = -1; cmdInput.value = ""; }
      }
    } else if (ev.key === "l" && ev.ctrlKey) {
      ev.preventDefault();
      logEl.innerHTML = "";
    }
  });

  cmdInput.addEventListener("keyup", (ev) => {
    if (["Enter", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Escape"].includes(ev.key)) return;
    updateSuggestions();
  });
}

async function applySuggest(index) {
  const item = suggestItems[index];
  if (!item) return;
  if (suggestMode === "commands") {
    cmdInput.value = item;
    hideSuggest();
    cmdInput.focus();
  } else if (suggestMode === "models") {
    hideSuggest();
    await selectModel(item.providerId, item.id, item.displayName);
  } else if (suggestMode === "providers") {
    hideSuggest();
    openApiModal(item);
  } else if (suggestMode === "mode") {
    hideSuggest();
    if (!configCache) configCache = {};
    configCache.mode = item.id;
    persistConfigCache();
    try { await invoke("save_config", { config: configCache }); } catch (e) {}
    logLine("mod: " + item.id, "ok");
  }
}

const TOOL_RISKS = {
  read_file: "low", list_dir: "low", search_code: "low", glob_files: "low", web_fetch: "low", analyze_codebase: "low",
  write_file: "medium", edit_file: "medium", create_dir: "medium", apply_diff: "medium", manage_memory: "medium", browser_automation: "medium", spawn_sub_agent: "medium",
  delete_file: "high", execute_command: "high", manage_background_process: "high", github_action: "high",
};

let sessionAllow = {};
let pendingApproval = null;
let approvalTimer = null;
const APPROVAL_TIMEOUT = 60;

function allowKey(toolId, params) {
  if (toolId === "execute_command") {
    const first = (params.command || params.cmd || "").split(/\s+/)[0] || "";
    return toolId + ":" + first.toLowerCase();
  }
  return toolId + ":" + (params.path || "").toLowerCase();
}

async function addPersistentAllow(toolId, params) {
  const key = allowKey(toolId, params);
  if (!configCache) return;
  if (!configCache.allowList) configCache.allowList = [];
  if (!configCache.allowList.includes(key)) {
    configCache.allowList.push(key);
    persistConfigCache();
    try { await invoke("save_config", { config: configCache }); } catch (e) {}
  }
}

const approvalModal = document.getElementById("approval-modal");
const apprTool = document.getElementById("appr-tool");
const apprRisk = document.getElementById("appr-risk");
const apprDetail = document.getElementById("appr-detail");
const apprEdit = document.getElementById("appr-edit");
const apprEditInput = document.getElementById("appr-edit-input");
const approvalVisibility = createVisibilityController(uiMotion, {
  root: approvalModal,
  surface: approvalModal.querySelector(".approval-window"),
  openDuration: UI_MOTION.fast,
  surfaceOpenDuration: UI_MOTION.dialog,
  closeDuration: UI_MOTION.fast,
  surfaceCloseDuration: UI_MOTION.fast,
});

function wordDiff(oldText, newText) {
  const o = String(oldText || "");
  const n = String(newText || "");
  let prefix = 0;
  while (prefix < o.length && prefix < n.length && o[prefix] === n[prefix]) prefix++;
  let suffix = 0;
  while (suffix < o.length - prefix && suffix < n.length - prefix && o[o.length - 1 - suffix] === n[n.length - 1 - suffix]) suffix++;
  const oMid = o.slice(prefix, o.length - suffix);
  const nMid = n.slice(prefix, n.length - suffix);
  return {
    oldHtml: escapeHtml(o.slice(0, prefix)) + '<span class="diff-word-del">' + escapeHtml(oMid) + "</span>" + escapeHtml(o.slice(o.length - suffix)),
    newHtml: escapeHtml(n.slice(0, prefix)) + '<span class="diff-word-add">' + escapeHtml(nMid) + "</span>" + escapeHtml(n.slice(n.length - suffix)),
  };
}

function parseUnifiedDiff(diffContent) {
  const lines = String(diffContent || "").split("\n");
  const out = [];
  let oldLine = 0, newLine = 0, add = 0, del = 0;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { oldLine = parseInt(m[1], 10); newLine = parseInt(m[2], 10); }
      out.push({ type: "hunk", text: line });
    } else if (line.startsWith("---") || line.startsWith("+++")) {
      out.push({ type: "context", text: line });
    } else if (line.startsWith("-")) {
      out.push({ type: "del", old: oldLine++, text: line.slice(1) }); del++;
    } else if (line.startsWith("+")) {
      out.push({ type: "add", new: newLine++, text: line.slice(1) }); add++;
    } else {
      out.push({ type: "context", old: oldLine++, new: newLine++, text: line.slice(1) });
    }
  }
  return { lines: out, add, del };
}

function renderDiffHtml(toolId, params) {
  if (toolId === "apply_diff") {
    const { lines, add, del } = parseUnifiedDiff(params.diff_content);
    let html = '<div class="diff-metrics">' + escapeHtml(shortPath(params.path || "")) + ' <span class="m-add">+' + add + '</span> <span class="m-del">-' + del + "</span></div>";
    for (const l of lines) {
      if (l.type === "hunk") html += '<div class="diff-hunk">' + escapeHtml(l.text) + "</div>";
      else if (l.type === "add") html += '<div class="diff-line diff-add"><span class="diff-num"></span><span class="diff-num">' + (l.new || "") + '</span><span class="diff-sign">+</span><span>' + escapeHtml(l.text) + "</span></div>";
      else if (l.type === "del") html += '<div class="diff-line diff-del"><span class="diff-num">' + (l.old || "") + '</span><span class="diff-num"></span><span class="diff-sign">-</span><span>' + escapeHtml(l.text) + "</span></div>";
      else html += '<div class="diff-line diff-context"><span class="diff-num">' + (l.old || "") + '</span><span class="diff-num">' + (l.new || "") + '</span><span class="diff-sign"> </span><span>' + escapeHtml(l.text) + "</span></div>";
    }
    return html;
  }

  if (toolId === "edit_file") {
    const oldLines = String(params.old_string || params.old || "").split("\n");
    const newLines = String(params.new_string || params.new || "").split("\n");
    let html = '<div class="diff-metrics">' + escapeHtml(shortPath(params.path || "")) + ' <span class="m-add">+' + newLines.length + '</span> <span class="m-del">-' + oldLines.length + "</span></div>";
    let o = 1, n = 1;
    for (const ol of oldLines) html += '<div class="diff-line diff-del"><span class="diff-num">' + o++ + '</span><span class="diff-num"></span><span class="diff-sign">-</span><span>' + escapeHtml(ol) + "</span></div>";
    for (const nl of newLines) html += '<div class="diff-line diff-add"><span class="diff-num"></span><span class="diff-num">' + n++ + '</span><span class="diff-sign">+</span><span>' + escapeHtml(nl) + "</span></div>";
    if (oldLines.length === 1 && newLines.length === 1) {
      const wd = wordDiff(params.old_string || params.old, params.new_string || params.new);
      html = '<div class="diff-metrics">' + escapeHtml(shortPath(params.path || "")) + ' <span class="m-add">+1</span> <span class="m-del">-1</span></div>' +
        '<div class="diff-line diff-del"><span class="diff-num">1</span><span class="diff-num"></span><span class="diff-sign">-</span><span>' + wd.oldHtml + "</span></div>" +
        '<div class="diff-line diff-add"><span class="diff-num"></span><span class="diff-num">1</span><span class="diff-sign">+</span><span>' + wd.newHtml + "</span></div>";
    }
    return html;
  }

  if (toolId === "write_file") {
    const contentLines = String(params.content || "").split("\n");
    let html = '<div class="diff-metrics">' + escapeHtml(shortPath(params.path || "")) + ' <span class="m-add">+' + contentLines.length + " lines in new file</span></div>";
    let n = 1;
    for (const cl of contentLines.slice(0, 60)) html += '<div class="diff-line diff-add"><span class="diff-num"></span><span class="diff-num">' + n++ + '</span><span class="diff-sign">+</span><span>' + escapeHtml(cl) + "</span></div>";
    if (contentLines.length > 60) html += '<div class="diff-hunk">... ' + (contentLines.length - 60) + " lines hidden</div>";
    return html;
  }

  return null;
}

function buildToolDetailHtml(toolId, params) {
  const diffHtml = renderDiffHtml(toolId, params);
  if (diffHtml) return diffHtml;
  let text = "";
  switch (toolId) {
    case "execute_command": text = "> " + (params.command || params.cmd || ""); break;
    default: text = params.path || params.pattern || params.url || JSON.stringify(params);
  }
  return '<div class="diff-line diff-context"><span class="diff-num"></span><span class="diff-num"></span><span class="diff-sign"> </span><span>' + escapeHtml(text) + "</span></div>";
}

function stopCountdown() {
  clearInterval(approvalTimer);
  approvalTimer = null;
  const hint = document.querySelector(".approval-hint");
  if (hint) hint.textContent = "[y] approve · [a] for session · [p] always · [n] deny · [e] edit · [Esc] cancel";
}

function startCountdown() {
  let remaining = APPROVAL_TIMEOUT;
  const hint = document.querySelector(".approval-hint");
  const base = "[y] approve · [a] for session · [p] always · [n] deny · [e] edit · [Esc] cancel";
  const tick = () => {
    if (remaining <= 0) {
      stopCountdown();
      const r = pendingApproval;
      if (r) { closeApproval(); r.resolve("once"); }
      return;
    }
    if (hint) hint.textContent = "Auto-approving in " + remaining + "s... (" + base + ")";
    remaining--;
  };
  tick();
  approvalTimer = setInterval(tick, 1000);
}

function showApproval(toolId, params, risk) {
  return new Promise((resolve) => {
    pendingApproval = { toolId, params, resolve };
    apprTool.textContent = toolId;
    apprRisk.textContent = risk.toUpperCase() + " RISK";
    apprRisk.className = "approval-risk risk-" + risk;
    apprDetail.innerHTML = buildToolDetailHtml(toolId, params);
    apprEdit.style.display = "none";
    void approvalVisibility.open();
    revealMenuContent(approvalModal, ".approval-header, .approval-detail, .approval-hint", {
      delay: 55,
      stagger: 28,
      maxItems: 4,
    });
    cmdInput.disabled = true;
    startCountdown();
  });
}

function closeApproval() {
  stopCountdown();
  void approvalVisibility.close();
  pendingApproval = null;
  cmdInput.disabled = false;
}

document.addEventListener("keydown", (ev) => {
  if (approvalModal.style.display !== "flex" || !pendingApproval) return;
  const key = ev.key.toLowerCase();
  if (apprEdit.style.display !== "none") {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); applyEditToParams(); return; }
    if (ev.key === "Escape") { ev.preventDefault(); apprEdit.style.display = "none"; return; }
    return;
  }
  ev.preventDefault();
  if (key === "y") { const r = pendingApproval; closeApproval(); r.resolve("once"); }
  else if (key === "a") { const r = pendingApproval; sessionAllow[r.toolId] = true; closeApproval(); r.resolve("once"); }
  else if (key === "p") { const r = pendingApproval; addPersistentAllow(r.toolId, r.params); closeApproval(); r.resolve("once"); }
  else if (key === "n" || ev.key === "Escape") { const r = pendingApproval; closeApproval(); r.resolve("deny"); }
  else if (key === "e") {
    const r = pendingApproval;
    const current = r.params.command || r.params.cmd || r.params.content || r.params.new_string || r.params.new || "";
    apprEditInput.value = current;
    apprEdit.style.display = "block";
    apprEditInput.focus();
  }
});

function applyEditToParams() {
  const r = pendingApproval;
  if (!r) return;
  const edited = apprEditInput.value;
  if (r.params.command !== undefined) r.params.command = edited;
  else if (r.params.cmd !== undefined) r.params.cmd = edited;
  else if (r.params.content !== undefined) r.params.content = edited;
  else if (r.params.new_string !== undefined) r.params.new_string = edited;
  else if (r.params.new !== undefined) r.params.new = edited;
  apprDetail.innerHTML = buildToolDetailHtml(r.toolId, r.params);
  apprEdit.style.display = "none";
}

function buildToolSummary(toolId, result) {
  switch (toolId) {
    case "read_file": return String(result.content || "").slice(0, 2000);
    case "list_dir": return (result.entries || []).map((e) => (e.is_dir ? e.name + "/" : e.name)).join(", ").slice(0, 1000);
    case "search_code": return (result.matches || []).map((m) => m.file + ":" + m.line + " " + m.text).join("\n").slice(0, 1500);
    case "glob_files": return (result.files || []).join("\n").slice(0, 1000) || "(no matches)";
    case "web_fetch": return String(result.content || "").slice(0, 2000);
    case "analyze_codebase": {
      if (result.tree) return (result.tree || []).join("\n").slice(0, 1500);
      return (result.matches || []).map((m) => m.file + ":" + m.line + " " + m.text).join("\n").slice(0, 1500);
    }
    case "browser_automation":
    case "github_action":
    case "apply_diff":
    case "create_dir":
    case "manage_memory":
      return result.message || "completed";
    case "manage_background_process": return JSON.stringify(result).slice(0, 800);
    case "spawn_sub_agent": return String(result.sub_agent_reply || "").slice(0, 2000);
    case "execute_command": {
      let s = "";
      if (result.stdout) s += String(result.stdout).slice(0, 1500);
      if (result.stderr) s += "\nSTDERR: " + String(result.stderr).slice(0, 500);
      if (result.exit_code !== 0) s += "\nexit code: " + result.exit_code;
      return s || "(no output)";
    }
    default: return result.message || "completed";
  }
}

function pathShort(p) {
  const home = (configCache && configCache.home) || "";
  return String(p || "");
}

async function executeTool(toolId, params, approved) {
  const started = Date.now();
  const isCmd = toolId === "execute_command";
  const cmdStr = params.command || params.cmd || "";
  const target = params.path || params.url || params.pattern || "";

  const activePath = toolWorkingPath(toolId, params);
  if (activePath) updatePath(activePath);

  const shortTarget = shortPath(target);
  const displayTarget = isCmd ? cmdStr.slice(0, 60) : shortTarget.slice(0, 60);
  const label = toolId + "  " + displayTarget;
  const item = logItem(label, { time: "", status: "run", toolName: toolId, target: displayTarget });

  try {
    const result = await invoke("execute_approved_tool", { config: configCache, toolId, params, approved });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    item.setTime(elapsed + "s");

    const failed = result.exit_code !== 0 && !result.message && !result.content && !result.entries && !result.matches && !result.files && !result.sub_agent_reply;
    if (failed) {
      item.setStatus("err");
      item.lbl.classList.add("err");
    } else {
      item.setStatus("ok");
    }

    let summary = null;
    if (toolId === "write_file") {
      const n = String(params.content || "").split("\n").length;
      summary = "files: 1 · +" + n;
    } else if (toolId === "edit_file") {
      const oldN = String(params.old_string || params.old || "").split("\n").length;
      const newN = String(params.new_string || params.new || "").split("\n").length;
      summary = "files: 1 · +" + newN + " -" + oldN;
    } else if (toolId === "apply_diff") {
      const { add, del } = parseUnifiedDiff(params.diff_content);
      summary = "files: 1 · +" + add + " -" + del;
    } else if (toolId === "delete_file") {
      summary = "files: 1 · -1";
    }

    let bodyParts = [];
    if (summary) bodyParts.push('[summary] ' + summary);
    if (isCmd) {
      const stdoutLines = String(result.stdout || "").split("\n").filter((l) => l.trim());
      const stderrLines = String(result.stderr || "").split("\n").filter((l) => l.trim());
      const all = stdoutLines.length + stderrLines.length;
      let shownOut = stdoutLines, shownErr = stderrLines, hidden = 0;
      if (all > 60) { hidden = all - 60; shownOut = stdoutLines.slice(0, 45); shownErr = stderrLines.slice(0, 15); }
      bodyParts.push(shownOut.join("\n"));
      if (shownErr.length) bodyParts.push('[stderr]\n' + shownErr.join("\n"));
      if (hidden > 0) bodyParts.push('... ' + hidden + " lines hidden");
      if (result.exit_code !== 0) bodyParts.push('[exit] ' + result.exit_code);
    } else if (toolId === "list_dir") {
      const entries = result.entries || [];
      let gridHtml = '<div class="dir-grid">';
      if (entries.length === 0) gridHtml = '<div class="log-item-body-content">(bo?)</div>';
      for (const e of entries.slice(0, 120)) {
        gridHtml += e.is_dir
          ? '<span class="dir">' + escapeHtml(e.name) + "/</span>"
          : '<span class="file">' + escapeHtml(e.name) + "</span>";
      }
      gridHtml += "</div>";
      item.body.innerHTML = gridHtml;
    } else if (toolId === "read_file") {
      const lines = String(result.content || "").split("\n");
      const numbered = lines.slice(0, 80).map((l, i) => String(i + 1).padStart(4, " ") + " | " + l).join("\n");
      bodyParts.push(numbered);
      if (lines.length > 80) bodyParts.push('... ' + (lines.length - 80) + " more lines");
    } else if (toolId === "search_code" || toolId === "analyze_codebase") {
      const matches = result.matches || [];
      bodyParts.push(matches.slice(0, 40).map((m) => String(m.file).split(/[\\/]/).pop() + ":" + m.line + "  " + m.text).join("\n") || "(no matches)");
    } else if (toolId === "web_fetch") {
      bodyParts.push(String(result.content || "").slice(0, 4000));
    } else if (toolId === "glob_files") {
      bodyParts.push((result.files || []).join("\n"));
    } else {
      if (result.message) bodyParts.push(result.message);
    }

    if (toolId === "write_file" || toolId === "edit_file" || toolId === "apply_diff") {
      item.body.innerHTML = renderDiffHtml(toolId, params);
    } else if (toolId === "list_dir") {
    } else {
      item.body.textContent = bodyParts.join("\n\n");
    }
    autoScroll();
    return buildToolSummary(toolId, result);
  } catch (e) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    item.setTime(elapsed + "s");
    item.setStatus("err");
    item.lbl.classList.add("err");
    item.body.textContent = String(e);
    autoScroll();
    return "ERROR: " + e;
  }
}

async function processToolItem(call) {
  const toolId = call.name;
  const params = (call.arguments && typeof call.arguments === "object") ? call.arguments : {};
  const risk = TOOL_RISKS[toolId] || "medium";

  if (configCache && configCache.mode === "autonomous") {
    return await executeTool(toolId, params, true);
  }
  if (sessionAllow[toolId]) {
    return await executeTool(toolId, params, true);
  }
  if (configCache && configCache.allowList && configCache.allowList.includes(allowKey(toolId, params))) {
    return await executeTool(toolId, params, true);
  }

  let check;
  try {
    check = await invoke("check_tool", { config: configCache, toolId, params });
  } catch (e) {
    renderAlert("Error: " + e);
    return "ERROR: " + e;
  }

  if (check.decision === "deny") {
    renderAlert("Blocked: " + check.reason);
    return "BLOCKED: " + check.reason;
  }
  if (check.decision === "allow") {
    return await executeTool(toolId, params, true);
  }

  const decision = await showApproval(toolId, params, check.risk || risk);
  if (decision === "deny") {
    renderAlert("Denied: " + toolId);
    return "DENIED BY USER";
  }
  return await executeTool(toolId, params, true);
}

async function sendChat(message) {
  if (!invoke) return;
  if (!TauriChannel) {
    renderAlert("This Tauri version does not support streaming channels.");
    return;
  }
  cmdInput.readOnly = true;
  setAgentState("working");
  try {
    const config = await invoke("get_config");
    if (!config) {
      cmdInput.focus();
      return;
    }
    configCache = upgradeProviderConfig(config);
    let homeDir = "";
    try {
      homeDir = await invoke("home");
      HOME_DIR = homeDir;
    } catch (e) {}

    await ensureSession(message);
    conversationHistory.push({ role: "user", content: message });
    await checkpointSession(null, "active");
    const maxTurns = 12;

    for (let turn = 0; turn < maxTurns; turn++) {
      let history = effectiveRequestHistory(configCache, homeDir);
      if (shouldAutoCompact(history)) {
        const compacted = await performCompaction("auto", homeDir);
        if (compacted.compacted) {
          logLine(`Context auto-compacted · ${fmtK(compacted.before)} → ${fmtK(compacted.after)} tokens`, "sys");
          history = effectiveRequestHistory(configCache, homeDir);
        }
      }

      countApiCall();
      const turnRequestId = requestId();
      activeRequestId = turnRequestId;
      if (streamActions) streamActions.hidden = false;
      lastStreamSequence = 0;
      activeStreamRenderer = null;
      let streamedReasoning = "";
      const providerRequestStartedAt = performance.now();
      let providerElapsedMs = null;
      const onEvent = new TauriChannel();
      onEvent.onmessage = (packet) => {
        const event = packet?.event;
        const data = packet?.data || {};
        const sequence = Number(data.sequence || 0);
        if (activeRequestId !== turnRequestId || sequence <= lastStreamSequence) return;
        lastStreamSequence = sequence;
        if (event === "textDelta") {
          if (!activeStreamRenderer) activeStreamRenderer = createStreamRenderer();
          activeStreamRenderer.append(data.delta || "");
          scheduleDraftCheckpoint({
            requestId: turnRequestId,
            text: activeStreamRenderer.text,
            reasoning: streamedReasoning,
            startedAt: Date.now(),
          });
        } else if (event === "reasoningDelta") {
          streamedReasoning += String(data.delta || "");
        } else if (event === "completed") {
          providerElapsedMs = Number(data.elapsedMs || 0);
        }
      };

      let reply;
      try {
        reply = await invoke("chat_completion_stream", {
          config: configCache,
          messages: history,
          requestId: turnRequestId,
          onEvent,
        });
        setConnectionOnline(true);
      } catch (error) {
        if (isNetworkFailure(error)) setConnectionOnline(false);
        const cancelled = String(error).toLowerCase().includes("durduruldu");
        if (activeStreamRenderer) activeStreamRenderer.interrupt();
        await checkpointSession(activeStreamRenderer?.text ? {
          requestId: turnRequestId,
          text: activeStreamRenderer.text,
          reasoning: streamedReasoning,
          startedAt: Date.now(),
        } : null, "interrupted");
        if (!cancelled) throw error;
        logLine("Response stopped", "sys");
        break;
      } finally {
        if (activeRequestId === turnRequestId) activeRequestId = null;
        if (streamActions) streamActions.hidden = true;
      }
      if (checkpointTimer) { clearTimeout(checkpointTimer); checkpointTimer = null; }
      const observation = createProviderObservation(
        configCache,
        reply,
        providerElapsedMs || (performance.now() - providerRequestStartedAt),
      );
      if (currentSession) {
        normalizeSessionIntelligence(currentSession);
        currentSession.usage.lastRequest = observation;
      }
      recordReplyUsage(reply, history);
      updateCtxGauge(history, reply);

      const text = String(reply.text || "");
      const toolCalls = reply.tool_calls || [];
      let progressEl = null;

      if (activeStreamRenderer) {
        progressEl = await activeStreamRenderer.finish(toolCalls.length > 0 ? "step" : "final");
      } else if (text.trim() && toolCalls.length > 0) {
        progressEl = await animatedRichMessage(text, "ai-step");
      } else if (text.trim()) {
        const gap = document.createElement("div");
        gap.className = "final-gap";
        appendLogElement(gap);
        await animatedRichMessage(text, "assistant-response");
      }

      if (text.trim() || toolCalls.length > 0) {
        conversationHistory.push({
          role: "assistant",
          content: text,
          toolCalls: toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            thoughtSignature: call.thoughtSignature || null,
          })),
          reasoningContent: reply.reasoning || null,
          thinkingSignature: reply.thinking_signature || null,
        });
        await checkpointSession(null, "active");
      }

      if (toolCalls.length === 0) {
        void generateSmartSessionTitle(message, text);
        break;
      }

      const canParallelizeReads = toolCalls.length > 1
        && configCache?.mode !== "strict"
        && toolCalls.every((call) => TOOL_RISKS[call.name] === "low");
      const rawResults = canParallelizeReads
        ? await Promise.all(toolCalls.map((call) => processToolItem(call)))
        : await (async () => {
            const ordered = [];
            for (const call of toolCalls) ordered.push(await processToolItem(call));
            return ordered;
          })();
      const results = rawResults.map((result, index) =>
        "[tool:" + toolCalls[index].name + "] " + (result || "")
      );
      if (progressEl) progressEl.classList.add("complete");

      for (let i = 0; i < toolCalls.length; i++) {
        conversationHistory.push({ role: "tool", toolCallId: toolCalls[i].id, content: results[i] || "" });
      }
      await checkpointSession(null, "active");
    }
    if (currentSession?.status !== "interrupted") await checkpointSession(null, "complete");
  } catch (e) {
    if (isNetworkFailure(e)) setConnectionOnline(false);
    renderAlert("Error: " + e);
  } finally {
    if (checkpointTimer) { clearTimeout(checkpointTimer); checkpointTimer = null; }
    activeRequestId = null;
    activeStreamRenderer = null;
    cmdInput.readOnly = false;
    if (streamActions) streamActions.hidden = true;
    setAgentState("ready");
    cmdInput.focus();
  }
}

// ===== KOMUTLAR =====
async function runCommand(cmd) {
  const trimmed = cmd.trim();
  if (!trimmed.startsWith("/")) return;

  const parts = trimmed.split(/\s+/);
  const rawName = parts[0];
  const name = rawName.replace(/^\//, "");
  const args = parts.slice(1);

  try {
    switch (name) {
      case "model":
      case "models":
        await openModelMenu();
        break;

      case "thinking":
      case "mode":
      case "reasoning":
        toggleThinkingBar();
        break;

      case "provider":
        if (!args[0]) {
          await openProviderMenu();
        } else if (args[0] === "test" && args[1]) {
          await testLinkedProvider(args[1]);
        } else if (args[0] === "reconnect" && args[1]) {
          await reconnectProvider(args[1]);
        } else if (args[0] === "remove" && args[1]) {
          await removeLinkedProvider(args[1]);
        } else {
          logLine("Usage: /provider [test|reconnect|remove] <id>", "sys");
        }
        break;

      case "diagnostics":
      case "doctor":
        await openDiagnosticsMenu();
        break;

      case "permissions":
        openModeMenu();
        break;

      case "status":
        renderSessionStatus();
        break;

      case "compact": {
        if (activeRequestId) {
          logLine("Compaction cannot start while a response is active", "err");
          break;
        }
        cmdInput.readOnly = true;
        setAgentState("working");
        try {
          let homeDir = HOME_DIR;
          if (!homeDir) {
            try { homeDir = await invoke("home"); } catch (error) {}
          }
          const result = await performCompaction("manual", homeDir || "");
          if (!result.compacted) logLine(result.reason, "dim");
          else logLine(`Compaction complete · ${fmtK(result.before)} → ${fmtK(result.after)} · ${fmtK(result.saved)} tokens saved`, "ok");
        } finally {
          cmdInput.readOnly = false;
          setAgentState("ready");
          cmdInput.focus();
        }
        break;
      }

      case "sessions":
        await openSessionsMenu();
        break;

      case "new":
        await newSession();
        break;

      case "resume":
        await openSessionsMenu();
        break;

      case "delete-session":
        await openDeleteSessionsMenu();
        break;

      case "undo":
        try {
          const undoMsg = await invoke("undo_last");
          logLine(undoMsg, "ok");
        } catch (e) {
          renderAlert("undo: " + e);
        }
        break;

      case "clear":
        logEl.innerHTML = "";
        break;

      default:
        renderAlert("Unknown command: " + rawName);
        break;
    }
  } catch (e) {
    renderAlert("Error: " + e);
  }
}

async function init() {
  loadConfigCache();

  if (!invoke) {
    modalAllItems = Object.values(PROVIDER_REGISTRY).map((p) => ({ id: p.id, name: p.name, provider: p }));
    openModal("providers");
    return;
  }
  await hydrateProviderRegistry();
  configCache = upgradeProviderConfig(configCache);
  try {
    const config = upgradeProviderConfig(await invoke("get_config"));
    try { HOME_DIR = await invoke("home"); } catch (e) {}
    const providerMeta = config ? PROVIDER_REGISTRY[config.provider] : null;
    const hasConfig = config && config.provider && hasProviderCredential(config, providerMeta);
    if (hasConfig) {
      isInitialized = true;
      configCache = config;
      try { await invoke("save_config", { config }); } catch (e) {}
      persistConfigCache();
      updateModelChip(config.model);
      const p = PROVIDER_REGISTRY[config.provider];
      if (p) providerNameCache = p.name;
      try {
        const home = await invoke("home");
        const cwd = await invoke("pwd");
        WORKSPACE_DIR = cwd;
        updatePath(cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd);
      } catch (e) {
        updatePath("~");
      }
    } else {
      configCache = null;
      modelCache = null;
      try { localStorage.removeItem("appConfig"); } catch (e) {}
      try { localStorage.removeItem(PUBLIC_MODEL_CACHE_KEY); } catch (e) {}
      isInitialized = false;
      modalAllItems = Object.values(PROVIDER_REGISTRY).map((p) => ({ id: p.id, name: p.name, provider: p }));
      openModal("providers");
    }
  } catch (e) {
    configCache = null;
    modelCache = null;
    try { localStorage.removeItem("appConfig"); } catch (_) {}
    try { localStorage.removeItem(PUBLIC_MODEL_CACHE_KEY); } catch (_) {}
    isInitialized = false;
    modalAllItems = Object.values(PROVIDER_REGISTRY).map((p) => ({ id: p.id, name: p.name, provider: p }));
    openModal("providers");
  }
  if (isInitialized) {
    try {
      const latest = await invoke("latest_session");
      if (latest) {
        await resumeSession(latest.id);
      }
    } catch (error) {
      logLine("Could not load session history: " + safeError(error), "sys");
    }
  }
}

document.addEventListener("keydown", (event) => {
  if (!isThinkingBarOpen) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeThinkingBar();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    if (thinkingModesList.length > 0) {
      thinkingActiveIndex = (thinkingActiveIndex - 1 + thinkingModesList.length) % thinkingModesList.length;
      renderThinkingInlineTrack();
      const selected = thinkingModesList[thinkingActiveIndex];
      if (selected) void applyThinkingSelection(selected.id);
    }
    return;
  }
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    event.stopPropagation();
    if (thinkingModesList.length > 0) {
      thinkingActiveIndex = (thinkingActiveIndex + 1) % thinkingModesList.length;
      renderThinkingInlineTrack();
      const selected = thinkingModesList[thinkingActiveIndex];
      if (selected) void applyThinkingSelection(selected.id);
    }
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopPropagation();
    const selected = thinkingModesList[thinkingActiveIndex];
    if (selected) void applyThinkingSelection(selected.id);
    closeThinkingBar();
  }
});

document.addEventListener("click", (event) => {
  if (!isThinkingBarOpen) return;
  if (!event.target.closest(".dock-meta-left")) {
    closeThinkingBar();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  suggestVisibility.finish();
  modalVisibility.finish();
  apiVisibility.finish();
  sessionDeleteVisibility.finish();
  statusVisibility.finish();
  diagnosticsVisibility.finish();
  approvalVisibility.finish();
});

init();
