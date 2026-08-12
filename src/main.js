// ===== GFM MARKDOWN MOTORU (markdown-it) =====
import markdownit from "./vendor/markdown-it.esm.min.mjs";

const mdRenderer = markdownit({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
});

// ===== Terminal UI — main.js =====
// FAZ 7: DOM tabanlı kart mimarisi (xterm yerine)

// ===== Error arka kapısı =====
const errOverlay = document.getElementById("err-overlay");
let errTimer = null;

function showErrorOverlay(msg) {
  if (!errOverlay) return;
  errOverlay.textContent = "HATA: " + msg;
  errOverlay.style.display = "block";
  clearTimeout(errTimer);
  errTimer = setTimeout(() => {
    errOverlay.style.display = "none";
  }, 8000);
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

// ===== Tauri API =====
const tauriCore = window.__TAURI__?.core;
const tauriWindow = window.__TAURI__?.window;
const invoke = tauriCore?.invoke;

// ===== DOM RENDERER — kart tabanlı akış =====
const logEl = document.getElementById("log");
const mainArea = document.querySelector(".main-area");

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function autoScroll() {
  if (!mainArea) return;
  const atBottom = mainArea.scrollTop >= mainArea.scrollHeight - mainArea.clientHeight - 16;
  if (atBottom) mainArea.scrollTop = mainArea.scrollHeight;
}

function logLine(text, cls) {
  const div = document.createElement("div");
  div.className = "log-line" + (cls ? " " + cls : "");
  div.textContent = text;
  logEl.appendChild(div);
  autoScroll();
  return div;
}

// Kullanıcı girdi bloğu — sol çizgili, belirgin
function userBlock(text) {
  const div = document.createElement("div");
  div.className = "user-block";
  div.textContent = text;
  logEl.appendChild(div);
  autoScroll();
  return div;
}

// Nihai ajan yanıtı — markdown render + emoji temizle
function assistantFinal(text) {
  const div = document.createElement("div");
  div.className = "assistant-final";
  div.innerHTML = renderMd(stripEmojis(replacePaths(text)));
  logEl.appendChild(div);
  autoScroll();
  return div;
}

// AGENT ACTION CARD — tam şeffaf cam, akıcı açılma, ASCII semboller
function logItem(label, opts) {
  opts = opts || {};
  const item = document.createElement("div");
  item.className = "log-item";
  item.dataset.status = opts.status || "busy";

  const head = document.createElement("div");
  head.className = "log-item-head";

  // Semboller: [~] düşünce, [>] araç, [OK] başarı, [ERR] hata
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

  // Akıcı açılma için grid sarmalayıcı
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

  logEl.appendChild(item);
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches && item.animate) {
    item.animate(
      [
        { opacity: 0, transform: "translateY(-7px) scaleY(0.76)", filter: "blur(4px)" },
        { opacity: 1, transform: "translateY(0) scaleY(1)", filter: "blur(0)" },
      ],
      { duration: 250, easing: "cubic-bezier(0.2, 0.9, 0.25, 1)" }
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

// Düşünce kartı kaldırıldı — reasoning payload'ı gelmiyor;
// boş düşünce kartları basılmaz (şartlı düşünce), ara açıklamalar dışarıda akar.

// ===== YOL KISALTMA — home → ~ =====
let HOME_DIR = "";
let WORKSPACE_DIR = "";

function shortPath(p) {
  const s = String(p || "");
  if (HOME_DIR && s.toLowerCase().startsWith(HOME_DIR.toLowerCase())) {
    return "~" + s.slice(HOME_DIR.length);
  }
  return s;
}

// ===== MARKDOWN + EMOJİ TEMİZLİĞİ =====

// Yol kısaltma — nihai yanıttaki tam Windows yolları ~ ile değiştirilir
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

function renderMd(text) {
  return mdRenderer.render(String(text || ""));
}

// Hata kutusu — şeffaf kırmızı cam callout
function renderAlert(msg) {
  const div = document.createElement("div");
  div.className = "alert-box";
  div.textContent = msg;
  logEl.appendChild(div);
  autoScroll();
  return div;
}

// Mouse spotlight — kartların üzerinde imleç takibi
document.addEventListener("mousemove", (e) => {
  const cards = document.querySelectorAll(".log-item");
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      card.style.setProperty("--mx", e.clientX - r.left + "px");
      card.style.setProperty("--my", e.clientY - r.top + "px");
    }
  }
});

// typeText — DOM'da akıcı yazma + satır animasyonu + markdown/emoji temizliği
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function typeText(text, cls) {
  const raw = stripEmojis(replacePaths(String(text || ""))).trim();
  if (!raw) return null;

  const el = document.createElement("div");
  el.className = "log-line rich-message type-anim is-typing" + (cls ? " " + cls : "");
  el.setAttribute("aria-live", "polite");
  logEl.appendChild(el);

  const chunks = raw.split(/(\s+)/);
  for (const chunk of chunks) {
    if (!chunk) continue;
    el.textContent += chunk;
    autoScroll();
    await sleep(8);
  }

  el.innerHTML = renderMd(raw);
  el.classList.remove("is-typing");
  autoScroll();
  return el;
}

// ===== PROVIDER REGISTRY =====
const PROVIDER_REGISTRY = {
  nvidia: { id: "nvidia", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", defaultModel: "nvidia/llama-3.3-nemotron-super-49b-v1", requiresApiKey: true },
  openai: { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o", requiresApiKey: true },
  anthropic: { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-3-5-sonnet-20241022", requiresApiKey: true },
  gemini: { id: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-3.6-flash", requiresApiKey: true },
  groq: { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile", requiresApiKey: true },
  deepseek: { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", requiresApiKey: true },
  together: { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", requiresApiKey: true },
  fireworks: { id: "fireworks", name: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct", requiresApiKey: true },
  openrouter: { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "auto", requiresApiKey: true },
  ollama: { id: "ollama", name: "Ollama (Local)", baseUrl: "http://localhost:11434", defaultModel: "llama3.3", requiresApiKey: false },
  custom: { id: "custom", name: "Custom Server", baseUrl: "", defaultModel: "", requiresApiKey: true },
};

// ===== STATE =====
let isInitialized = false;
let providerNameCache = null;
let configCache = null;

function persistConfigCache() {
  try { localStorage.setItem("appConfig", JSON.stringify(configCache)); } catch (e) {}
}

function loadConfigCache() {
  try {
    const raw = localStorage.getItem("appConfig");
    if (raw) {
      configCache = JSON.parse(raw);
      if (configCache && !configCache.mode) configCache.mode = "smart";
    }
  } catch (e) {}
}

// ===== API MODAL =====
const apiModal = document.getElementById("api-modal");
const apiKeyInput = document.getElementById("api-key-input");
const apiKeySubtext = document.getElementById("api-key-subtext");
const apiKeyError = document.getElementById("api-key-error");
let apiModalProvider = null;

function openApiModal(p) {
  apiModalProvider = p;
  apiModal.style.display = "flex";
  apiKeyInput.value = "";
  apiKeyError.textContent = "";
  apiKeyInput.classList.remove("error");
  if (!p.requiresApiKey) {
    apiKeySubtext.textContent = "Bağlanılıyor...";
    connectProvider(p, "");
  } else {
    apiKeySubtext.textContent = p.name + " API Key";
    apiKeyInput.focus();
  }
}

function closeApiModal() {
  apiModal.style.display = "none";
  apiModalProvider = null;
  cmdInput.focus();
}

async function connectProvider(provider, apiKey) {
  try {
    const baseUrl = provider.baseUrl;
    countApiCall(); // validate ? API limitine dahil
    await invoke("validate_api_key", { provider: provider.id, apiKey, baseUrl });

    const prev = configCache || (await invoke("get_config")) || {};
    const newProvider = { id: provider.id, apiKey, baseUrl, model: provider.defaultModel };
    const providers = Array.isArray(prev.providers) && prev.providers.length > 0
      ? prev.providers.filter((p) => (p.id || p.provider) !== provider.id)
      : (prev.apiKey ? [{ id: prev.provider, apiKey: prev.apiKey, baseUrl: prev.baseUrl, model: prev.model }] : []);
    providers.push(newProvider);

    configCache = {
      provider: provider.id,
      apiKey,
      baseUrl,
      model: provider.defaultModel,
      mode: prev.mode || "smart",
      allowList: prev.allowList || [],
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
    apiKeyError.textContent = "Geçersiz API Key — " + e;
    apiKeySubtext.textContent = "";
    setTimeout(() => apiKeyInput.classList.remove("error"), 1500);
  }
}

document.addEventListener("keydown", (ev) => {
  if (apiModal.style.display !== "flex") return;
  if (ev.key === "Enter") {
    ev.preventDefault();
    if (!apiModalProvider) return;
    const key = apiKeyInput.value.trim();
    if (!key && apiModalProvider.requiresApiKey) {
      apiKeyInput.classList.add("error");
      apiKeyError.textContent = "Geçersiz API Key";
      setTimeout(() => apiKeyInput.classList.remove("error"), 1500);
      return;
    }
    apiKeySubtext.textContent = "Doğrulanıyor...";
    connectProvider(apiModalProvider, key);
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    closeApiModal();
  }
});

// ===== WINDOW CONTROLS =====
const btnClose = document.getElementById("btn-close");
const btnMin = document.getElementById("btn-min");
const btnMax = document.getElementById("btn-max");

if (btnClose) btnClose.addEventListener("click", async () => { try { await tauriWindow?.getCurrentWindow()?.close(); } catch (e) {} });
if (btnMin) btnMin.addEventListener("click", async () => { try { await tauriWindow?.getCurrentWindow()?.minimize(); } catch (e) {} });
if (btnMax) btnMax.addEventListener("click", async () => { try { await tauriWindow?.getCurrentWindow()?.toggleMaximize(); } catch (e) {} });

// ===== HEADER — model chip + path + ctx çizgisi =====
const modelChip = document.getElementById("model-chip");
const modelNameEl = document.getElementById("model-name");
const pathEl = document.getElementById("path");
const ctxFill = document.getElementById("ctx-fill");
const ctxStatus = document.getElementById("ctx-status");
const apiCountEl = document.getElementById("api-count");

// API çağrı sayacı — oturumdaki LLM isteği sayısı
let apiCallCount = 0;
function countApiCall() {
  apiCallCount++;
  if (apiCountEl) apiCountEl.textContent = "API " + apiCallCount;
}

function setAgentState(state) {
  if (ctxStatus) ctxStatus.dataset.state = state;
}

function shortModelName(model) {
  const s = String(model || "");
  return s.split("/").pop().slice(0, 24);
}

function updateModelChip(model) {
  if (modelChip && modelNameEl) {
    modelNameEl.textContent = shortModelName(model);
    modelChip.title = model || "";
  }
}

if (modelChip) {
  modelChip.addEventListener("click", () => openModelMenu());
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

function compactThresholdFor(config) {
  return Math.floor(contextLimitOf(config) * contextRatioOf(config));
}

function estimateTokens(history) {
  let total = 0;
  for (const m of history) {
    total += Math.ceil(String(m.content || "").length / 4);
  }
  return total;
}

function fmtK(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

// Context çizgisi + tooltip
function updateCtxGauge(history, reply) {
  if (!ctxFill) return;
  const config = configCache;
  const limit = contextLimitOf(config);
  const ratio = contextRatioOf(config);
  const inTok = estimateTokens(history);
  const outTok = reply ? Math.ceil(String(reply.text || "").length / 4) : 0;
  const total = inTok + outTok;
  const pct = Math.min(100, (total / limit) * 100);

  const tone = pct > 90 ? "#f87171" : pct > 70 ? "#facc15" : "#ffffff";
  ctxFill.style.setProperty("--ctx-angle", (pct * 3.6) + "deg");
  ctxFill.style.setProperty("--ctx-tone", tone);
  ctxFill.classList.toggle("mid", pct > 70 && pct <= 90);
  ctxFill.classList.toggle("high", pct > 90);

  if (ctxStatus) {
    ctxStatus.title = "Context: " + fmtK(total) + " / " + fmtK(limit) + " (" + pct.toFixed(1) + "%) — eşik %" + Math.round(ratio * 100);
    ctxStatus.setAttribute("aria-valuenow", String(Math.round(pct)));
    ctxStatus.setAttribute("aria-label", "Context yüzde " + Math.round(pct));
  }
}

function compactHistory(history) {
  if (!history || history.length <= 2) return history;
  const compacted = [history[0]];
  if (history[1]) compacted.push(history[1]);
  for (let i = 2; i < history.length; i++) {
    const m = history[i];
    if (m.role === "assistant") {
      compacted.push({ role: "assistant", content: String(m.content || "").slice(0, 500), toolCalls: m.toolCalls });
    } else if (m.role === "tool") {
      compacted.push({ role: "tool", toolCallId: m.toolCallId, content: String(m.content || "").slice(0, 200) });
    } else {
      compacted.push(m);
    }
  }
  return compacted;
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
const COMMANDS = ["/model", "/provider", "/permissions", "/context", "/undo", "/clear"];
let suggestMode = null;
let suggestItems = [];
let suggestIndex = 0;

function showSuggest(items, mode) {
  suggestMode = mode;
  suggestItems = items;
  suggestIndex = 0;
  suggestPanel.innerHTML = "";
  items.forEach((it, i) => {
    const el = document.createElement("div");
    el.className = "suggest-item" + (i === 0 ? " active" : "");
    el.textContent = typeof it === "string" ? it : (it.name || it.id);
    suggestPanel.appendChild(el);
  });
  suggestPanel.style.display = "block";
}

function updateActiveItem() {
  const items = suggestPanel.querySelectorAll(".suggest-item");
  items.forEach((el, i) => el.classList.toggle("active", i === suggestIndex));
}

function hideSuggest() {
  suggestPanel.style.display = "none";
  suggestPanel.innerHTML = "";
  suggestItems = [];
  suggestIndex = 0;
  suggestMode = null;
}

// ===== MODAL (model/provider/mod) =====
const modal = document.getElementById("modal");
const modalSearchInput = document.getElementById("modal-search-input");
const modalList = document.getElementById("modal-list");
let modalMode = null;
let modalAllItems = [];
let modalItems = [];
let modalIndex = 0;
let modelCache = null;

function openModal(mode) {
  modalMode = mode;
  modal.style.display = "flex";
  modalSearchInput.value = "";
  renderModalList(modalAllItems);
  modalSearchInput.focus();
  updateModalActive();
}

function closeModal() {
  modal.style.display = "none";
  modalMode = null;
  modalItems = [];
  modalIndex = 0;
  cmdInput.focus();
}

function renderModalList(items) {
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
    Object.keys(groups).forEach((g) => {
      const header = document.createElement("div");
      header.className = "modal-category";
      header.textContent = g;
      modalList.appendChild(header);
      groups[g].forEach((it) => {
        const el = document.createElement("div");
        el.className = "modal-item";
        el.textContent = it.id;
        modalList.appendChild(el);
        modalItems.push({ el, item: it });
      });
    });
  } else if (modalMode === "mode") {
    const header = document.createElement("div");
    header.className = "modal-category";
    header.textContent = "Erişim Modu";
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
      : (configCache && configCache.apiKey ? [configCache.provider] : []);
    items.forEach((it, i) => {
      const el = document.createElement("div");
      el.className = "modal-item";
      const isConnected = linked.includes(it.id);
      const isActive = configCache && configCache.provider === it.id;
      el.textContent = it.name + (isActive ? "  ✓" : isConnected ? "  ·" : "");
      if (isActive) connectedIdx = i;
      modalList.appendChild(el);
      modalItems.push({ el, item: it });
    });
    if (configCache) modalIndex = connectedIdx;
  }
}

function updateModalActive() {
  modalItems.forEach((row, i) => row.el.classList.toggle("active", i === modalIndex));
  const active = modalItems[modalIndex];
  if (active) {
    const list = modalList;
    const top = active.el.offsetTop - list.offsetTop;
    const bottom = top + active.el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }
}

function filterModal() {
  const q = modalSearchInput.value.toLowerCase();
  if (!q) {
    renderModalList(modalAllItems);
    updateModalActive();
    return;
  }
  if (modalMode === "models") {
    const filtered = modalAllItems.filter((it) => it.id.toLowerCase().includes(q) || (it.providerName || "").toLowerCase().includes(q));
    renderModalList(filtered);
  } else if (modalMode === "mode") {
    const filtered = modalAllItems.filter((it) => it.name.toLowerCase().includes(q));
    renderModalList(filtered);
  } else {
    const filtered = Object.values(PROVIDER_REGISTRY)
      .filter((p) => p.name.toLowerCase().includes(q))
      .map((p) => ({ id: p.id, name: p.name, provider: p }));
    renderModalList(filtered);
  }
  updateModalActive();
}

async function selectModalItem() {
  const row = modalItems[modalIndex];
  if (!row) return;

  if (modalMode === "models") {
    await selectModel(row.item.providerId, row.item.id);
    closeModal();
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
    closeModal();
    const linked = (configCache && configCache.providers && configCache.providers.length > 0)
      ? configCache.providers
      : (configCache && configCache.apiKey ? [configCache] : []);
    const existing = linked.find((lp) => (lp.id || lp.provider) === p.id);
    if (existing && existing.apiKey) {
      configCache.provider = p.id;
      configCache.apiKey = existing.apiKey;
      configCache.baseUrl = existing.baseUrl;
      configCache.model = existing.model;
      providerNameCache = p.name;
      persistConfigCache();
      try { await invoke("save_config", { config: configCache }); } catch (e) {}
      openModelMenu();
      return;
    }
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

  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    if (modalItems.length > 0) {
      modalIndex = (modalIndex + 1) % modalItems.length;
      updateModalActive();
    }
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    if (modalItems.length > 0) {
      modalIndex = (modalIndex - 1 + modalItems.length) % modalItems.length;
      updateModalActive();
    }
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
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Enter" || ev.key === "Escape") return;
    filterModal();
  });
}

// ===== MODEL YÖNETİMİ =====
async function getModels() {
  if (modelCache) return modelCache;
  let config;
  try {
    config = configCache || (await invoke("get_config"));
  } catch (e) {
    logLine("config okunamadı: " + e, "err");
    return [];
  }
  if (!config) return [];

  const providers = config.providers && config.providers.length > 0 ? config.providers : [config];
  const all = [];
  for (const p of providers) {
    try {
      const pConfig = {
        provider: p.id || p.provider,
        apiKey: p.apiKey,
        baseUrl: p.baseUrl,
        model: p.model || "",
        mode: config.mode || "smart",
        allowList: config.allowList || [],
      };
      countApiCall(); // list_models — API limitine dahil
      const models = await invoke("list_models", { config: pConfig });
      const pName = (PROVIDER_REGISTRY[p.id || p.provider] || {}).name || p.id || "Provider";
      for (const id of models) {
        all.push({ providerId: p.id || p.provider, providerName: pName, id });
      }
    } catch (e) {
      // Sessiz değil — hata görünür olsun
      logLine("model listesi alınamadı (" + (p.id || p.provider) + "): " + e, "err");
    }
  }
  // Boş sonucu cache'leme — sonraki denemede tekrar çekilsin
  if (all.length > 0) modelCache = all;
  return all;
}

async function selectModel(providerId, id) {
  const config = configCache || (await invoke("get_config"));
  if (!config) return;

  // KRİTİK: provider değişiyorsa apiKey/baseUrl'i o provider'ın kaydından al
  // (aksi halde eski provider'ın key'i ile yeni provider'a istek gider → 405/401)
  const providerEntry = (config.providers || []).find((p) => (p.id || p.provider) === providerId);
  if (providerEntry && providerEntry.apiKey) {
    config.apiKey = providerEntry.apiKey;
    config.baseUrl = providerEntry.baseUrl;
  }

  config.provider = providerId;
  config.model = id;
  if (!config.providers || config.providers.length === 0) {
    config.providers = [{ id: config.provider, apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model }];
  }
  const target = config.providers.find((p) => (p.id || p.provider) === providerId);
  if (target) target.model = id;
  await invoke("save_config", { config });
  configCache = config;
  persistConfigCache();
  updateModelChip(id);
  const p = PROVIDER_REGISTRY[providerId];
  if (p) providerNameCache = p.name;
  cmdInput.focus();
}

async function openModelMenu() {
  hideSuggest();
  let models = [];
  try {
    models = await getModels();
  } catch (e) {
    logLine("model listesi alınamadı: " + e, "err");
  }
  if (models.length === 0) {
    // Fallback: ağ/limit hatası — tüm bağlı provider'ların mevcut modellerini göster
    try {
      const cfg = configCache || (await invoke("get_config"));
      if (cfg) {
        const providerList = cfg.providers && cfg.providers.length > 0 ? cfg.providers : [cfg];
        for (const p of providerList) {
          const pName = (PROVIDER_REGISTRY[p.id || p.provider] || {}).name || p.id || "Provider";
          const m = (p.id || p.provider) === cfg.provider ? cfg.model : p.model;
          if (m) {
            models.push({ providerId: p.id || p.provider, providerName: pName, id: m });
          }
        }
        if (models.length) logLine("ağ/limit hatası — mevcut modeller gösteriliyor", "sys");
      }
    } catch (e2) {}
  }
  if (models.length === 0) return;
  modalAllItems = models;
  openModal("models");
}

function openProviderMenu() {
  hideSuggest();
  modalAllItems = Object.values(PROVIDER_REGISTRY).map((p) => ({ id: p.id, name: p.name, provider: p }));
  openModal("providers");
}

function openModeMenu() {
  hideSuggest();
  modalAllItems = [
    { id: "smart", name: "smart — okuma otomatik, yazma/tehlikeli onaylı" },
    { id: "strict", name: "strict — her şey onay ister" },
    { id: "autonomous", name: "autonomous — tam otonom, onay yok" },
  ];
  openModal("mode");
}

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

// ===== KOMUT INPUT =====
const cmdInput = document.getElementById("cmd-input");
let cmdHistory = [];
let historyIdx = -1;

if (cmdInput) {
  cmdInput.addEventListener("keydown", async (ev) => {
    if (suggestMode === "models" || suggestMode === "providers" || suggestMode === "mode") {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        suggestIndex = (suggestIndex + (ev.key === "ArrowDown" ? 1 : -1) + suggestItems.length) % suggestItems.length;
        updateActiveItem();
        return;
      }
      if (ev.key === "Enter") { ev.preventDefault(); await applySuggest(suggestIndex); return; }
      if (ev.key === "Escape") { ev.preventDefault(); hideSuggest(); return; }
      if (ev.key.length === 1) hideSuggest();
    }

    if (suggestMode === "commands") {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        suggestIndex = (suggestIndex + (ev.key === "ArrowDown" ? 1 : -1) + suggestItems.length) % suggestItems.length;
        updateActiveItem();
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
        hideSuggest();
        await runCommand(cmd);
        cmdInput.value = "";
      } else {
        cmdHistory.push(cmd);
        historyIdx = -1;
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
    if (ev.key === "Enter" || ev.key === "ArrowUp" || ev.key === "ArrowDown" || ev.key === "Escape") return;
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
    await selectModel(item.providerId, item.id);
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

// ===== TOOL REGISTRY =====
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

// ===== ONAY MODALI + DIFF =====
const approvalModal = document.getElementById("approval-modal");
const apprTool = document.getElementById("appr-tool");
const apprRisk = document.getElementById("appr-risk");
const apprDetail = document.getElementById("appr-detail");
const apprEdit = document.getElementById("appr-edit");
const apprEditInput = document.getElementById("appr-edit-input");

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
    let html = '<div class="diff-metrics">' + escapeHtml(shortPath(params.path || "")) + ' <span class="m-add">+' + contentLines.length + " satır yeni dosya</span></div>";
    let n = 1;
    for (const cl of contentLines.slice(0, 60)) html += '<div class="diff-line diff-add"><span class="diff-num"></span><span class="diff-num">' + n++ + '</span><span class="diff-sign">+</span><span>' + escapeHtml(cl) + "</span></div>";
    if (contentLines.length > 60) html += '<div class="diff-hunk">... ' + (contentLines.length - 60) + " satır gizlendi</div>";
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
  if (hint) hint.textContent = "[y] onayla · [a] oturum için · [p] her zaman · [n] reddet · [e] düzenle · [Esc] iptal";
}

function startCountdown() {
  let remaining = APPROVAL_TIMEOUT;
  const hint = document.querySelector(".approval-hint");
  const base = "[y] onayla · [a] oturum için · [p] her zaman · [n] reddet · [e] düzenle · [Esc] iptal";
  const tick = () => {
    if (remaining <= 0) {
      stopCountdown();
      const r = pendingApproval;
      if (r) { closeApproval(); r.resolve("once"); }
      return;
    }
    if (hint) hint.textContent = remaining + "s içinde otomatik onaylanacak... (" + base + ")";
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
    approvalModal.style.display = "flex";
    cmdInput.disabled = true;
    startCountdown();
  });
}

function closeApproval() {
  stopCountdown();
  approvalModal.style.display = "none";
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

// ===== TOOL YÜRÜTME =====
function buildToolSummary(toolId, result) {
  switch (toolId) {
    case "read_file": return String(result.content || "").slice(0, 2000);
    case "list_dir": return (result.entries || []).map((e) => (e.is_dir ? e.name + "/" : e.name)).join(", ").slice(0, 1000);
    case "search_code": return (result.matches || []).map((m) => m.file + ":" + m.line + " " + m.text).join("\n").slice(0, 1500);
    case "glob_files": return (result.files || []).join("\n").slice(0, 1000) || "(eşleşme yok)";
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
      return result.message || "tamamlandı";
    case "manage_background_process": return JSON.stringify(result).slice(0, 800);
    case "spawn_sub_agent": return String(result.sub_agent_reply || "").slice(0, 2000);
    case "execute_command": {
      let s = "";
      if (result.stdout) s += String(result.stdout).slice(0, 1500);
      if (result.stderr) s += "\nSTDERR: " + String(result.stderr).slice(0, 500);
      if (result.exit_code !== 0) s += "\nçıkış kodu: " + result.exit_code;
      return s || "(çıktı yok)";
    }
    default: return result.message || "tamamlandı";
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

  // Dinamik yol — header'ı son işlem dizinine güncelle
  const activePath = toolWorkingPath(toolId, params);
  if (activePath) updatePath(activePath);

  // AgentActionCard — [>] ile başlar, yol kısaltılır
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

    // Codex tarzı diff özeti
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

    // Body — açılınca görünen içerik (summary + çıktı)
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
      if (hidden > 0) bodyParts.push('... ' + hidden + " satır gizlendi");
      if (result.exit_code !== 0) bodyParts.push('[exit] ' + result.exit_code);
    } else if (toolId === "list_dir") {
      // 3 s?tunlu esnek grid
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
      if (lines.length > 80) bodyParts.push('... ' + (lines.length - 80) + " satır daha");
    } else if (toolId === "search_code" || toolId === "analyze_codebase") {
      const matches = result.matches || [];
      bodyParts.push(matches.slice(0, 40).map((m) => String(m.file).split(/[\\/]/).pop() + ":" + m.line + "  " + m.text).join("\n") || "(eşleşme yok)");
    } else if (toolId === "web_fetch") {
      bodyParts.push(String(result.content || "").slice(0, 4000));
    } else if (toolId === "glob_files") {
      bodyParts.push((result.files || []).join("\n"));
    } else {
      if (result.message) bodyParts.push(result.message);
    }

    // write/edit → interaktif diff viewer (VS Code stili)
    if (toolId === "write_file" || toolId === "edit_file" || toolId === "apply_diff") {
      item.body.innerHTML = renderDiffHtml(toolId, params);
    } else if (toolId === "list_dir") {
      // grid zaten item.body.innerHTML'e yazıldı — dokunma (ezme bug'ı düzeltildi)
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
    return "HATA: " + e;
  }
}

// NATIVE tool çağrısı
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
    renderAlert("hata: " + e);
    return "HATA: " + e;
  }

  if (check.decision === "deny") {
    renderAlert("engellendi: " + check.reason);
    return "ENGELLENDİ: " + check.reason;
  }
  if (check.decision === "allow") {
    return await executeTool(toolId, params, true);
  }

  const decision = await showApproval(toolId, params, check.risk || risk);
  if (decision === "deny") {
    renderAlert("reddedildi: " + toolId);
    return "KULLANICI REDDETTİ";
  }
  return await executeTool(toolId, params, true);
}

// ===== NATIVE CHAT — ReAct döngüsü =====
async function sendChat(message) {
  if (!invoke) return;
  cmdInput.disabled = true;
  setAgentState("working");
  try {
    const config = await invoke("get_config");
    if (!config) {
      cmdInput.disabled = false;
      cmdInput.focus();
        return;
    }
    let homeDir = "";
    try {
      homeDir = await invoke("home");
      HOME_DIR = homeDir;
    } catch (e) {}

    let history = [
      { role: "system", content: buildSystemPrompt(config, homeDir) },
      { role: "user", content: message },
    ];
    const maxTurns = 12;
    const isShortPrompt = message.trim().length < 24;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (!isShortPrompt && estimateTokens(history) > compactThresholdFor(config)) {
        history = compactHistory(history);
        logLine("[SYSTEM: bağlam sıkıştırıldı — eski çıktılar özetlendi]", "sys");
      }

      countApiCall(); // LLM isteği — limit sayacı
      const reply = await invoke("chat_completion", { config, messages: history });
      updateCtxGauge(history, reply);

      const text = String(reply.text || "");
      const toolCalls = reply.tool_calls || [];
      let progressEl = null;

      // Ara açıklamalar (tool çağrısı olan tur) → kart dışında sönük canlı akış
      if (text.trim() && toolCalls.length > 0) {
        progressEl = await typeText(text, "ai-step");
      }

      // Nihai yanıt (tool yok) — üst boşlukla, normal parlaklıkta
      if (text.trim() && toolCalls.length === 0) {
        const gap = document.createElement("div");
        gap.className = "final-gap";
        logEl.appendChild(gap);
        await typeText(text, "assistant-response");
      }

      if (toolCalls.length === 0) {
        break;
      }

      const results = [];
      for (const call of toolCalls) {
        const res = await processToolItem(call);
        results.push("[tool:" + call.name + "] " + (res || ""));
      }
      if (progressEl) progressEl.classList.add("complete");

      history.push({
        role: "assistant",
        content: text || "",
        toolCalls: toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          arguments: c.arguments,
          thoughtSignature: c.thoughtSignature || null,
        })),
      });
      for (let i = 0; i < toolCalls.length; i++) {
        history.push({ role: "tool", toolCallId: toolCalls[i].id, content: results[i] || "" });
      }
    }
  } catch (e) {
    renderAlert("hata: " + e);
  } finally {
    cmdInput.disabled = false;
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

      case "provider":
        await openProviderMenu();
        break;

      case "permissions":
        openModeMenu();
        break;

      case "context":
        if (args[0]) {
          const val = parseFloat(args[0].replace(",", "."));
          if (!isNaN(val) && val > 0 && val <= 1) {
            if (!configCache) configCache = {};
            configCache.contextRatio = val;
            persistConfigCache();
            try { await invoke("save_config", { config: configCache }); } catch (e) {}
            logLine("context oranı: " + val + " (" + Math.round(val * 100) + "%) — eşik: " + Math.floor(contextLimitOf(configCache) * val), "ok");
          } else if (!isNaN(val) && val >= 8000 && val <= 4000000) {
            if (!configCache) configCache = {};
            configCache.contextLimit = Math.floor(val);
            persistConfigCache();
            try { await invoke("save_config", { config: configCache }); } catch (e) {}
            logLine("context limit: " + Math.floor(val) + " — eşik: " + Math.floor(val * contextRatioOf(configCache)), "ok");
          } else {
            logLine("geçersiz — 0-1 arası oran (0.8 = %80) veya 8000-4000000 arası limit girin", "err");
          }
        } else {
          const limit = contextLimitOf(configCache);
          const ratio = contextRatioOf(configCache);
          logLine("context: limit " + limit + " · oran " + ratio + " (%" + Math.round(ratio * 100) + ") · eşik " + Math.floor(limit * ratio) + " — /context 0.8 veya /context 1000000 ile değiştirilebilir", "dim");
        }
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
        renderAlert("bilinmeyen komut: " + rawName);
        break;
    }
  } catch (e) {
    renderAlert("hata: " + e);
  }
}

// ===== INIT =====
async function init() {
  loadConfigCache();

  if (!invoke) {
    modalAllItems = Object.values(PROVIDER_REGISTRY).map((p) => ({ id: p.id, name: p.name, provider: p }));
    openModal("providers");
    return;
  }
  try {
    const config = await invoke("get_config");
    try { HOME_DIR = await invoke("home"); } catch (e) {}
    const hasConfig = config && config.apiKey;
    if (hasConfig) {
      isInitialized = true;
      configCache = config;
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
      if (configCache && configCache.apiKey) {
        isInitialized = true;
        updateModelChip(configCache.model);
        const p = PROVIDER_REGISTRY[configCache.provider];
        if (p) providerNameCache = p.name;
      } else {
        modalAllItems = Object.values(PROVIDER_REGISTRY).map((p) => ({ id: p.id, name: p.name, provider: p }));
        openModal("providers");
      }
    }
  } catch (e) {
    if (configCache && configCache.apiKey) {
      isInitialized = true;
      updateModelChip(configCache.model);
      const p = PROVIDER_REGISTRY[configCache.provider];
      if (p) providerNameCache = p.name;
    } else {
      modalAllItems = Object.values(PROVIDER_REGISTRY).map((p) => ({ id: p.id, name: p.name, provider: p }));
      openModal("providers");
    }
  }
}

init();
