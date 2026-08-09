// ===== Terminal UI � main.js =====
// macOS terminal esteti�xi � Tauri + xterm.js
// NOT: window.__TAURI__ globali kullanılıyor (withGlobalTauri: true)

// ===== Error arka kapısı � hatalar ekranda görünsün =====
const errOverlay = document.getElementById("err-overlay");
let errTimer = null;

function showErrorOverlay(msg) {
  if (!errOverlay) return;
  errOverlay.textContent = "⚠ " + msg;
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

// ===== DevTools � Ctrl+Shift+D kısayolu + debug'da otomatik aç =====
function openDevTools() {
  try {
    const wv = window.__TAURI__?.webview?.getCurrentWebview();
    if (wv && wv.openDevTools) {
      wv.openDevTools();
      return;
    }
    const win = window.__TAURI__?.window?.getCurrentWindow();
    if (win && win.openDevTools) {
      win.openDevTools();
    }
  } catch (e) {
    // sessiz
  }
}

document.addEventListener("keydown", (ev) => {
  if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === "d") {
    ev.preventDefault();
    openDevTools();
  }
});

// xterm.js — yerel dosyalar (CDN engelleniyor: Tracking Prevention)
const xtermCss = document.createElement("link");
xtermCss.rel = "stylesheet";
xtermCss.href = "./vendor/xterm.css";
document.head.appendChild(xtermCss);

// Yerel ESM import
const { Terminal } = await import("./vendor/xterm.mjs");
const { FitAddon } = await import("./vendor/addon-fit.mjs");

// ===== PROVIDER REGISTRY � güncel modeller =====
const PROVIDER_REGISTRY = {
  nvidia: {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "nvidia/llama-3.3-nemotron-super-49b-v1",
    requiresApiKey: true,
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    requiresApiKey: true,
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-3-5-sonnet-20241022",
    requiresApiKey: true,
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-3.6-flash",
    requiresApiKey: true,
  },
  groq: {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    requiresApiKey: true,
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    requiresApiKey: true,
  },
  together: {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    requiresApiKey: true,
  },
  fireworks: {
    id: "fireworks",
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    requiresApiKey: true,
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "auto",
    requiresApiKey: true,
  },
  ollama: {
    id: "ollama",
    name: "Ollama (Local)",
    baseUrl: "http://localhost:11434",
    defaultModel: "llama3.3",
    requiresApiKey: false,
  },
  custom: {
    id: "custom",
    name: "Custom Server",
    baseUrl: "",
    defaultModel: "",
    requiresApiKey: true,
  },
};

// ===== Tauri API (window.__TAURI__ globali) =====
const tauriCore = window.__TAURI__?.core;
const tauriWindow = window.__TAURI__?.window;
const invoke = tauriCore?.invoke;

// Renk kodları (brief'ten)
const C = {
  primary: "\x1b[38;2;226;226;226m",   // #E2E2E2 ana metin
  secondary: "\x1b[38;2;136;136;136m", // #888888 ikincil
  green: "\x1b[38;2;74;222;128m",     // #4ADE80 success
  muted: "\x1b[38;2;85;85;85m",       // #555555 sönük
  red: "\x1b[38;2;239;68;68m",        // #EF4444 hata
  yellow: "\x1b[38;2;250;204;21m",    // #FACC15 rozet
  blue: "\x1b[38;2;96;165;250m",      // #60A5FA
  think: "\x1b[3m\x1b[38;2;119;119;119m", // italik loş gri — düşünce
  box: "\x1b[38;2;70;70;70m",         // #464646 kutu çizgileri
  reset: "\x1b[0m",
};

const term = new Terminal({
  fontFamily: '"JetBrains Mono", "Segoe UI Symbol", "Cascadia Code", "Consolas", monospace',
  fontSize: 13,
  fontWeight: "normal",
  lineHeight: 1.6,
  cursorBlink: false,
  cursorStyle: "block",
  allowTransparency: true,
  disableStdin: true,
  theme: {
    background: "#0d0d0d",
    foreground: "#e2e2e2",
    cursor: "#e2e2e2",
    cursorAccent: "#0d0d0d",
    selectionBackground: "#333333",
    black: "#0d0d0d",
    red: "#ff5f56",
    green: "#4ade80",
    yellow: "#ffbd2e",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#e2e2e2",
    brightBlack: "#666666",
    brightRed: "#ff7b72",
    brightGreen: "#86efac",
    brightYellow: "#fde047",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#ffffff",
  },
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

const terminalEl = document.getElementById("terminal");
term.open(terminalEl);

// Fit — layout hazır olunca birkaç kez dene (ilk ölçüm 0 olabilir)
function fitTerminal() {
  try {
    fitAddon.fit();
  } catch (e) {
    // sessiz
  }
}
requestAnimationFrame(fitTerminal);
setTimeout(fitTerminal, 150);
setTimeout(fitTerminal, 600);

// Container boyutu değişirse yeniden fit
if (typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(() => fitTerminal());
  ro.observe(terminalEl);
}

// ===== State =====
let isInitialized = false;
let providerNameCache = null;
let configCache = null; // config'in hafızadaki kopyası � get_config hata verse bile akı�x devam eder

// Config cache  localStorage'a kalıcı yaz (her açılı�xta API sormamak için)
function persistConfigCache() {
  try {
    localStorage.setItem("appConfig", JSON.stringify(configCache));
  } catch (e) {
    // sessiz
  }
}

function loadConfigCache() {
  try {
    const raw = localStorage.getItem("appConfig");
    if (raw) {
      configCache = JSON.parse(raw);
      // Mode garantisi — eski cache'lerde yoksa smart
      if (configCache && !configCache.mode) configCache.mode = "smart";
    }
  } catch (e) {
    // sessiz
  }
}

// ===== API Modal � API key giri�xi =====
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
    // Ollama gibi � key gerekmez, direkt ba�xlan
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
    await invoke("validate_api_key", {
      provider: provider.id,
      apiKey,
      baseUrl,
    });

    // Mevcut config'i koru — yeni provider'ı LİSTEYE EKLE (çoklu bağlantı)
    const prev = configCache || (await invoke("get_config")) || {};
    const newProvider = {
      id: provider.id,
      apiKey,
      baseUrl,
      model: provider.defaultModel,
    };
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

    // Başarılı — config'e kaydet
    await invoke("save_config", { config: configCache });

    isInitialized = true;
    modelCache = null; // yeni provider — cache temiz
    providerNameCache = provider.name;
    persistConfigCache();
    closeApiModal();
    // Model seçimi — provider bağlandıktan sonra model menüsü açılır
    openModelMenu();
  } catch (e) {
    // Başarısız — kırmızı border + uyarı
    apiKeyInput.classList.add("error");
    apiKeyError.textContent = "Geçersiz API Key — " + e;
    apiKeySubtext.textContent = "";
    setTimeout(() => apiKeyInput.classList.remove("error"), 1500);
  }
}

// API modal klavye � Enter do�xrula, Esc kapat
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

// ===== Dinamik çalı�xma dizini (pwd) =====
let currentCwd = "~";

async function updateCwd() {
  const pathEl = document.getElementById("path");
  if (!pathEl) return;
  if (!invoke) {
    pathEl.textContent = "~";
    return;
  }
  try {
    const cwd = await invoke("pwd");
    const home = await invoke("home").catch(() => "");
    currentCwd = shortenPath(cwd, home);
    pathEl.textContent = currentCwd;
  } catch (e) {
    pathEl.textContent = "~";
  }
}

function shortenPath(path, home) {
  if (home && path.startsWith(home)) {
    return "~" + path.slice(home.length).replace(/\\/g, "/");
  }
  return path.replace(/\\/g, "/");
}

updateCwd();

// ===== Window controls (macOS trafik lambaları) =====
const btnClose = document.getElementById("btn-close");
const btnMin = document.getElementById("btn-min");
const btnMax = document.getElementById("btn-max");

if (btnClose) {
  btnClose.addEventListener("click", async () => {
    try {
      if (tauriWindow) {
        const appWindow = tauriWindow.getCurrentWindow();
        await appWindow.close();
      }
    } catch (e) {
      console.error("close error:", e);
    }
  });
}

if (btnMin) {
  btnMin.addEventListener("click", async () => {
    try {
      if (tauriWindow) {
        const appWindow = tauriWindow.getCurrentWindow();
        await appWindow.minimize();
      }
    } catch (e) {
      console.error("minimize error:", e);
    }
  });
}

if (btnMax) {
  btnMax.addEventListener("click", async () => {
    try {
      if (tauriWindow) {
        const appWindow = tauriWindow.getCurrentWindow();
        await appWindow.toggleMaximize();
      }
    } catch (e) {
      console.error("maximize error:", e);
    }
  });
}

// ===== Komut input � alt alan =====
const cmdInput = document.getElementById("cmd-input");
let cmdHistory = [];
let historyIdx = -1;

// ===== Suggest panel � komut/model/provider önerileri =====
const suggestPanel = document.getElementById("suggest-panel");
const COMMANDS = ["/model", "/provider", "/permissions", "/context", "/undo", "/clear"];
let suggestMode = null; // "commands" | "models" | "providers"
let suggestItems = [];
let suggestIndex = 0;
let modelCache = null;

function showSuggest(items, mode) {
  suggestMode = mode;
  suggestItems = items;
  suggestIndex = 0;
  suggestPanel.innerHTML = "";
  items.forEach((it, i) => {
    const el = document.createElement("div");
    el.className = "suggest-item" + (i === 0 ? " active" : "");
    if (mode === "models") {
      el.textContent = it.id;
    } else if (mode === "providers") {
      el.textContent = it.name;
      const type = document.createElement("span");
      type.className = "suggest-type";
      type.textContent = it.requiresApiKey ? "key" : "local";
      el.appendChild(type);
    } else {
      el.textContent = it;
    }
    // Sadece klavye � mouse click devre dı�xı
    suggestPanel.appendChild(el);
  });
  suggestPanel.style.display = "block";
}

function updateActiveItem() {
  const items = suggestPanel.querySelectorAll(".suggest-item");
  items.forEach((el, i) => el.classList.toggle("active", i === suggestIndex));
  // Aktif item'ı görünür tut � scroll panel içinde takip etsin
  const activeEl = items[suggestIndex];
  if (activeEl) {
    activeEl.scrollIntoView({ block: "nearest" });
  }
}

function hideSuggest() {
  suggestPanel.style.display = "none";
  suggestPanel.innerHTML = "";
  suggestItems = [];
  suggestIndex = 0;
  suggestMode = null;
}

// ===== MODAL � model/provider seçim penceresi =====
const modal = document.getElementById("modal");
const modalSearchInput = document.getElementById("modal-search-input");
const modalList = document.getElementById("modal-list");
const modelLabel = document.getElementById("model-label");

let modalMode = null; // "models" | "providers"
let modalAllItems = []; // tüm item'lar {id} veya {name, ...}
let modalItems = []; // render edilmi�x (flat) item referansları
let modalIndex = 0;

function openModal(mode) {
  modalMode = mode;
  modal.style.display = "flex";
  modalSearchInput.value = "";
  if (mode === "models") {
    renderModalList(modalAllItems);
  } else if (mode === "providers") {
    renderModalList(Object.values(PROVIDER_REGISTRY).map((p) => ({ id: p.id, name: p.name, provider: p })));
  } else if (mode === "mode") {
    // Mod seçim menüsü — direkt render (boş görünme bug'ı düzeltildi)
    renderModalList(modalAllItems);
  }
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
    // Her bağlı provider için ayrı kategori başlığı
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
    // Mod seçimi — mevcut mod i�xaretli + odak
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
    if (configCache) {
      modalIndex = connectedIdx;
    }
  } else {
    // Providerlar — tek liste; bağlı provider'lar ✓ işaretli + aktif olan odakta
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
    if (configCache) {
      modalIndex = connectedIdx;
    }
  }
}

function currentProviderName() {
  if (providerNameCache) return providerNameCache;
  const first = Object.values(PROVIDER_REGISTRY)[0];
  return first ? first.name : "Provider";
}

function updateModalActive() {
  modalItems.forEach((row, i) => row.el.classList.toggle("active", i === modalIndex));
  const active = modalItems[modalIndex];
  if (active) {
    // Manuel scroll � akıcı, lag yok
    const list = modalList;
    const top = active.el.offsetTop - list.offsetTop;
    const bottom = top + active.el.offsetHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
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
    const filtered = modalAllItems.filter(
      (it) => it.id.toLowerCase().includes(q) || (it.providerName || "").toLowerCase().includes(q)
    );
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
    // Direkt seç — test yok
    await selectModel(row.item.providerId, row.item.id);
    closeModal();
  } else if (modalMode === "mode") {
    // Mod seçildi — kaydet
    const m = row.item.id;
    closeModal();
    if (!configCache) configCache = {};
    configCache.mode = m;
    persistConfigCache();
    try {
      await invoke("save_config", { config: configCache });
    } catch (e) {
      // sessiz
    }
    term.writeln(C.green + "✓ mod: " + C.reset + C.primary + m + C.reset);
  } else if (modalMode === "providers") {
    const p = row.item.provider;
    closeModal();
    // Zaten bağlıysa key sorma — direkt model menüsü (çoklu provider kontrolü)
    const linked = (configCache && configCache.providers && configCache.providers.length > 0)
      ? configCache.providers
      : (configCache && configCache.apiKey ? [configCache] : []);
    const existing = linked.find((lp) => (lp.id || lp.provider) === p.id);
    if (existing && existing.apiKey) {
      // Bağlı — aktif yap, key sorma
      configCache.provider = p.id;
      configCache.apiKey = existing.apiKey;
      configCache.baseUrl = existing.baseUrl;
      configCache.model = existing.model;
      providerNameCache = p.name;
      persistConfigCache();
      try {
        await invoke("save_config", { config: configCache });
      } catch (e) {
        // sessiz
      }
      openModelMenu();
      return;
    }
    // Yeni/bağlanmamış provider → API key girişi
    openApiModal(p);
  }
}

// Modal klavye yönetimi
document.addEventListener("keydown", (ev) => {
  if (!modalMode) return;

  // cmdInput'tan gelen event — modalı YENİ açan Enter'ın kalıntısı olabilir.
  // Bu durumda modal handler işlemesin (aksi halde menü anında ilk item'ı seçip kapanır).
  if (ev.target === cmdInput) return;

  // Arama input'una harf/backspace gitmesin diye — input focus'tayken kendi işler
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

// Arama input � canlı filtre
if (modalSearchInput) {
  modalSearchInput.addEventListener("keyup", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Enter" || ev.key === "Escape") {
      return;
    }
    filterModal();
  });
}

// Seçili modeli sa�x üstte göster
function updateModelLabel(model) {
  if (modelLabel) {
    modelLabel.textContent = model || "";
  }
}

// Tüm bağlı provider'ların modellerini topla
async function getModels() {
  if (modelCache) return modelCache;
  const config = configCache || (await invoke("get_config"));
  if (!config) return [];

  // Bağlı provider listesi — providers yoksa ana provider
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
      const models = await invoke("list_models", { config: pConfig });
      const pName = (PROVIDER_REGISTRY[p.id || p.provider] || {}).name || p.id || "Provider";
      for (const id of models) {
        all.push({ providerId: p.id || p.provider, providerName: pName, id });
      }
    } catch (e) {
      // o provider başarısız — atla
    }
  }
  modelCache = all;
  return all;
}

async function selectModel(providerId, id) {
  const config = configCache || (await invoke("get_config"));
  if (!config) return;

  // Aktif provider'ı seçilen modelin provider'ı yap
  config.provider = providerId;
  config.model = id;

  // Linked provider listesini güncelle
  if (!config.providers || config.providers.length === 0) {
    config.providers = [
      { id: config.provider, apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model },
    ];
  }
  const target = config.providers.find((p) => (p.id || p.provider) === providerId);
  if (target) {
    target.model = id;
  }

  // Kaydet
  await invoke("save_config", { config });
  configCache = config;
  persistConfigCache();
  updateModelLabel(id);
  const p = PROVIDER_REGISTRY[providerId];
  if (p) providerNameCache = p.name;
  cmdInput.focus();
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
    openApiModal(item); // provider seçildi → API key girişi
  }
}

async function openModelMenu() {
  hideSuggest();
  try {
    const models = await getModels();
    if (models.length === 0) {
      return;
    }
    modalAllItems = models;
    openModal("models");
  } catch (e) {
    // sessiz
  }
}

function openProviderMenu() {
  hideSuggest();
  modalAllItems = Object.values(PROVIDER_REGISTRY).map((p) => ({ id: p.id, name: p.name, provider: p }));
  openModal("providers");
}

// Erişim modu seçim menüsü — /mode yazınca açılır
function openModeMenu() {
  hideSuggest();
  modalAllItems = [
    { id: "smart", name: "smart — okuma otomatik, yazma/tehlikeli onaylı" },
    { id: "strict", name: "strict — her şey onay ister" },
    { id: "autonomous", name: "autonomous — tam otonom, onay yok" },
  ];
  openModal("mode");
}

// Autocomplete � sadece "/" ile ba�xlayan yazımlarda öneri
async function updateSuggestions() {
  // Menü (models/providers) açıkken otomatik güncelleme yok
  if (suggestMode === "models" || suggestMode === "providers") return;
  const v = cmdInput.value.trim();
  if (!v) {
    hideSuggest();
    return;
  }

  // Slash'sız yazım �  hiçbir öneri yok (komut sistemi kaldırıldı)
  if (!v.startsWith("/")) {
    hideSuggest();
    return;
  }

  const lower = v.toLowerCase();

  // Tam komut yazıldıysa öneri gösterme — Enter direkt komutu çalıştırsın
  // (ör. "/mode" yazınca "/model" önerilmesin, yanlışlıkla model menüsü açılmasın)
  if (COMMANDS.includes(lower)) {
    hideSuggest();
    return;
  }

  // Slash'lı komut önerisi — prefix match, alfabetik sıralı
  const matches = COMMANDS.filter((c) => c.startsWith(lower) && c !== lower).sort();
  if (matches.length > 0) {
    showSuggest(matches, "commands");
  } else {
    hideSuggest();
  }
}

if (cmdInput) {
  cmdInput.addEventListener("keydown", async (ev) => {
    // Panel açık (models/providers) � menü kontrolü
    if (suggestMode === "models" || suggestMode === "providers") {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        suggestIndex =
          (suggestIndex + (ev.key === "ArrowDown" ? 1 : -1) + suggestItems.length) %
          suggestItems.length;
        updateActiveItem();
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        await applySuggest(suggestIndex);
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        hideSuggest();
        return;
      }
      // Harf/karakter basıldı � menüyü kapat, input'a yazmaya devam et
      if (ev.key.length === 1) {
        hideSuggest();
      }
    }

    // Komut modunda Esc �  panel kapat
    if (suggestMode === "commands" && ev.key === "Escape") {
      ev.preventDefault();
      hideSuggest();
      return;
    }

    // Autocomplete panel (commands) açık � klavye navigasyonu
    if (suggestMode === "commands") {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        suggestIndex =
          (suggestIndex + (ev.key === "ArrowDown" ? 1 : -1) + suggestItems.length) %
          suggestItems.length;
        updateActiveItem();
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        // Input'ta TAM komut yazılıysa onu çalıştır (panel önerisi yanıltmasın)
        const typed = cmdInput.value.trim().toLowerCase();
        const item = suggestItems[suggestIndex];
        hideSuggest();
        if (typed.startsWith("/") && COMMANDS.includes(typed)) {
          cmdInput.value = "";
          await runCommand(typed);
          return;
        }
        // Değilse seçili öneriyi tamamla VE hemen çalıştır
        if (item) {
          cmdInput.value = "";
          if (item.startsWith("/")) {
            await runCommand(item);
          }
        }
        return;
      }
    }

    if (ev.key === "Enter") {
      ev.preventDefault();
      const cmd = cmdInput.value;
      if (cmd.trim() === "") {
        return;
      }

      // Slash'lı komut �  sessiz çalı�xtır (chatte görünmez)
      if (cmd.trim().startsWith("/")) {
        cmdHistory.push(cmd);
        historyIdx = -1;
        hideSuggest();
        await runCommand(cmd);
        cmdInput.value = "";
      } else {
        // Slash'sız yazı �  terminalde göster, LLM'den cevap al, bu sırada input kilitli
        cmdHistory.push(cmd);
        historyIdx = -1;
        term.writeln(C.muted + ">" + C.reset + " " + C.primary + cmd + C.reset);
        cmdInput.value = "";
        await sendChat(cmd);
      }
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (cmdHistory.length > 0) {
        if (historyIdx === -1) {
          historyIdx = cmdHistory.length - 1;
        } else if (historyIdx > 0) {
          historyIdx--;
        }
        cmdInput.value = cmdHistory[historyIdx] || "";
      }
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (historyIdx !== -1) {
        if (historyIdx < cmdHistory.length - 1) {
          historyIdx++;
          cmdInput.value = cmdHistory[historyIdx] || "";
        } else {
          historyIdx = -1;
          cmdInput.value = "";
        }
      }
    } else if (ev.key === "l" && ev.ctrlKey) {
      ev.preventDefault();
      term.clear();
    }
  });

  // Yazınca autocomplete güncelle
  cmdInput.addEventListener("keyup", (ev) => {
    if (
      ev.key === "Enter" ||
      ev.key === "ArrowUp" ||
      ev.key === "ArrowDown" ||
      ev.key === "Escape"
    ) {
      return;
    }
    updateSuggestions();
  });
}

// ===== LLM Chat — slash'sız yazılara cevap =====

// Hızlı akıcı yazma animasyonu — beyaz metin + akıllı auto-scroll
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function autoScroll() {
  try {
    const vp = term.element && term.element.querySelector(".xterm-viewport");
    if (!vp) return;
    // Kullanıcı yukarı kaydırdıysa kilitle (okuma modu)
    const isAtBottom = vp.scrollTop >= vp.scrollHeight - vp.clientHeight - 12;
    if (isAtBottom) term.scrollToBottom();
  } catch (e) {
    // sessiz
  }
}

async function typeText(text) {
  const lines = String(text).split("\n");
  for (const line of lines) {
    const chunks = line.split(/(\s+)/);
    for (const chunk of chunks) {
      if (!chunk) continue;
      term.write(C.primary + chunk);
      autoScroll();
      await sleep(10); // hızlı ve akıcı
    }
    term.write("\r\n");
    autoScroll();
  }
  term.write(C.reset + "");
}

// ===== FAZ 3+4: TOOL REGISTRY — risk sınıflandırma =====
function buildSystemPrompt(config, homeDir) {
  const desktopPath = homeDir
    ? homeDir + "\\OneDrive\\Desktop (or " + homeDir + "\\Desktop if missing)"
    : "home\\OneDrive\\Desktop";
  return (
    "You are a terminal assistant operating on the user's computer. You call tools to read, write, search files, run commands, fetch web pages, manage processes, and delegate subtasks. Execute the user's request end-to-end like a senior developer.\n\n" +
    "## Environment\n" +
    "- Home directory: " +
    (homeDir || "C:\\Users\\user") +
    "\n- Desktop: " +
    desktopPath +
    "\n- Resolve all paths dynamically. Never invent paths — verify with list_dir before assuming.\n" +
    "- OS: Windows. Commands run through cmd.\n\n" +
    "## Identity\n" +
    "- Your model identity is: " +
    config.model +
    ". State it verbatim when asked.\n" +
    "- You are an agent, not a chatbot: complete tasks with tools, do not just discuss them.\n\n" +
    "## Task Execution (To-Do Engine)\n" +
    "- Break complex requests into logical steps and execute them in order.\n" +
    "- Work on ONE step at a time. Do not attempt everything in a single tool call.\n" +
    "- Keep the user informed briefly: what you are doing and why (1 short line per step).\n" +
    "- Track progress mentally across turns — tool results are the ground truth of what has been done.\n" +
    "- Short follow-ups (\"devam et\", \"continue\", \"fix it\", \"hatayı düzelt\") refer to the CURRENT task: resume from the last tool result, never restart from zero.\n\n" +
    "## Auto-Plan Mode\n" +
    "- Complex/multi-step tasks (3+ actions, file modifications, investigations): BEFORE acting, present a short numbered plan (2-5 steps) to the user, then execute it step by step.\n" +
    "- Simple tasks (single read, quick answer): act immediately, no plan needed.\n" +
    "- After completing all plan steps, close with a concise summary of what was done.\n\n" +
    "## Mid-Flight Steering\n" +
    "- If the user interrupts (\"dur\", \"stop\", \"bekle\", \"wait\", \"change\", \"değiştir\", new instructions): stop the current action chain immediately and follow the new direction. Do not finish the old plan first.\n" +
    "- Preserve context from previous steps — the user expects continuity, not a fresh start.\n\n" +
    "## Tool Usage Discipline\n" +
    "- Choose the most specific tool for the job: read_file for content, list_dir for directory structure, search_code for locating symbols, web_fetch for web content, execute_command for shell operations.\n" +
    "- NEVER use shell commands (curl, Invoke-WebRequest, Out-File, dir, type) for file or web operations — always use the built-in tools.\n" +
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
    "- Respond in the user's language (Turkish unless requested otherwise).\n" +
    "- Be concise: short sentences, no filler. Use plain text — NEVER markdown (*, **, #, `, code fences).\n" +
    "- Plans and summaries: simple numbered lines, no decorations."
  );
}

// ===== FAZ 5: CONTEXT MANAGER — token tahmini + otomatik sıkıştırma =====

// Modüler bağlam limiti: config.json'daki contextLimit (mutlak) veya 128k varsayılan.
// Hardcode model haritası yok.
function contextLimitOf(config) {
  const v = config && config.contextLimit ? Number(config.contextLimit) : 0;
  return v >= 8000 && v <= 4000000 ? v : 131072;
}

// Oran: 1 = %100, 0.8 = %80 — config.json'daki contextRatio, default 0.8
function contextRatioOf(config) {
  const r = config && config.contextRatio !== undefined ? Number(config.contextRatio) : NaN;
  return !isNaN(r) && r > 0 && r <= 1 ? r : 0.8;
}

// Eşik = limit * oran
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

function updateTokenCounter(history, reply) {
  const el = document.getElementById("token-label");
  if (!el) return;
  const inTok = estimateTokens(history);
  const outTok = reply ? Math.ceil(String(reply).length / 4) : 0;
  el.textContent =
    "[In " + fmtK(inTok) + " | Out " + fmtK(outTok) + " | Total " + fmtK(inTok + outTok) + "]";
}

// Sıkıştırma: sistem + ilk kullanıcı korunur, araç çıktıları budanır
function compactHistory(history) {
  if (!history || history.length <= 2) return history;
  const compacted = [history[0]]; // sistem promptu
  if (history[1]) compacted.push(history[1]); // ilk kullanıcı mesajı (ana hedef)
  for (let i = 2; i < history.length; i++) {
    const m = history[i];
    if (m.role === "assistant") {
      compacted.push({ role: "assistant", content: String(m.content).slice(0, 500) });
    } else if (String(m.content).startsWith("Araç sonuçları:")) {
      const lineCount = String(m.content).split("\n").length;
      const snippet = String(m.content).slice(0, 120);
      compacted.push({
        role: "user",
        content:
          "[SYSTEM: " + lineCount + " satır araç çıktısı okundu ve analiz edildi — özet: " + snippet + "]",
      });
    } else {
      compacted.push(m);
    }
  }
  return compacted;
}

// ===== FAZ 3+4: TOOL REGISTRY — risk sınıflandırma =====
const TOOL_RISKS = {
  read_file: "low",
  list_dir: "low",
  search_code: "low",
  glob_files: "low",
  web_fetch: "low",
  analyze_codebase: "low",
  write_file: "medium",
  edit_file: "medium",
  create_dir: "medium",
  apply_diff: "medium",
  manage_memory: "medium",
  browser_automation: "medium",
  spawn_sub_agent: "medium",
  delete_file: "high",
  execute_command: "high",
  manage_background_process: "high",
  github_action: "high",
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
    try {
      await invoke("save_config", { config: configCache });
    } catch (e) {}
  }
}

const approvalModal = document.getElementById("approval-modal");
const apprTool = document.getElementById("appr-tool");
const apprRisk = document.getElementById("appr-risk");
const apprDetail = document.getElementById("appr-detail");
const apprEdit = document.getElementById("appr-edit");
const apprEditInput = document.getElementById("appr-edit-input");

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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
    let html = '<div class="diff-metrics">📄 ' + escapeHtml(params.path || "") + ' &nbsp; <span class="m-add">+' + add + '</span> <span class="m-del">-' + del + "</span></div>";
    for (const l of lines) {
      if (l.type === "hunk") {
        html += '<div class="diff-hunk">' + escapeHtml(l.text) + "</div>";
      } else if (l.type === "add") {
        html += '<div class="diff-line diff-add"><span class="diff-num"></span><span class="diff-num">' + (l.new || "") + '</span><span class="diff-sign">+</span><span>' + escapeHtml(l.text) + "</span></div>";
      } else if (l.type === "del") {
        html += '<div class="diff-line diff-del"><span class="diff-num">' + (l.old || "") + '</span><span class="diff-num"></span><span class="diff-sign">-</span><span>' + escapeHtml(l.text) + "</span></div>";
      } else {
        html += '<div class="diff-line diff-context"><span class="diff-num">' + (l.old || "") + '</span><span class="diff-num">' + (l.new || "") + '</span><span class="diff-sign"> </span><span>' + escapeHtml(l.text) + "</span></div>";
      }
    }
    return html;
  }

  if (toolId === "edit_file") {
    const oldLines = String(params.old_string || params.old || "").split("\n");
    const newLines = String(params.new_string || params.new || "").split("\n");
    let html = '<div class="diff-metrics">📄 ' + escapeHtml(params.path || "") + ' &nbsp; <span class="m-add">+' + newLines.length + '</span> <span class="m-del">-' + oldLines.length + "</span></div>";
    let o = 1, n = 1;
    for (const ol of oldLines) {
      html += '<div class="diff-line diff-del"><span class="diff-num">' + o++ + '</span><span class="diff-num"></span><span class="diff-sign">-</span><span>' + escapeHtml(ol) + "</span></div>";
    }
    for (const nl of newLines) {
      html += '<div class="diff-line diff-add"><span class="diff-num"></span><span class="diff-num">' + n++ + '</span><span class="diff-sign">+</span><span>' + escapeHtml(nl) + "</span></div>";
    }
    if (oldLines.length === 1 && newLines.length === 1) {
      const wd = wordDiff(params.old_string || params.old, params.new_string || params.new);
      html = '<div class="diff-metrics">📄 ' + escapeHtml(params.path || "") + ' &nbsp; <span class="m-add">+1</span> <span class="m-del">-1</span></div>' +
        '<div class="diff-line diff-del"><span class="diff-num">1</span><span class="diff-num"></span><span class="diff-sign">-</span><span>' + wd.oldHtml + "</span></div>" +
        '<div class="diff-line diff-add"><span class="diff-num"></span><span class="diff-num">1</span><span class="diff-sign">+</span><span>' + wd.newHtml + "</span></div>";
    }
    return html;
  }

  if (toolId === "write_file") {
    const contentLines = String(params.content || "").split("\n");
    let html = '<div class="diff-metrics">📄 ' + escapeHtml(params.path || "") + ' &nbsp; <span class="m-add">+' + contentLines.length + " satır yeni dosya</span></div>";
    let n = 1;
    for (const cl of contentLines.slice(0, 60)) {
      html += '<div class="diff-line diff-add"><span class="diff-num"></span><span class="diff-num">' + n++ + '</span><span class="diff-sign">+</span><span>' + escapeHtml(cl) + "</span></div>";
    }
    if (contentLines.length > 60) {
      html += '<div class="diff-hunk">… ' + (contentLines.length - 60) + " satır gizlendi</div>";
    }
    return html;
  }

  return null;
}

function buildToolDetailHtml(toolId, params) {
  const diffHtml = renderDiffHtml(toolId, params);
  if (diffHtml) return diffHtml;
  let text = "";
  switch (toolId) {
    case "execute_command":
      text = "> " + (params.command || params.cmd || "");
      break;
    default:
      text = params.path || params.pattern || params.url || JSON.stringify(params);
  }
  return '<div class="diff-line diff-context"><span class="diff-num"></span><span class="diff-num"></span><span class="diff-sign"> </span><span>' + escapeHtml(text) + "</span></div>";
}

function stopCountdown() {
  clearInterval(approvalTimer);
  approvalTimer = null;
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

async function executeTool(toolId, params, approved) {
  const started = Date.now();
  const isCmd = toolId === "execute_command";
  const cmdStr = params.command || params.cmd || "";

  if (isCmd) {
    term.writeln(C.box + "┌─" + C.reset + " ⚡ " + C.primary + cmdStr.slice(0, 55) + C.reset + " " + C.box + "─".repeat(8) + " " + C.yellow + "[RUNNING]" + C.reset + " " + C.box + "─┐" + C.reset);
    autoScroll();
  }

  try {
    const result = await invoke("execute_approved_tool", { config: configCache, toolId, params, approved });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (isCmd) {
      const stdoutLines = String(result.stdout || "").split("\n").filter((l) => l.trim());
      const stderrLines = String(result.stderr || "").split("\n").filter((l) => l.trim());
      const all = stdoutLines.length + stderrLines.length;
      let shownOut = stdoutLines, shownErr = stderrLines, hidden = 0;
      if (all > 22) { hidden = all - 22; shownOut = stdoutLines.slice(0, 16); shownErr = stderrLines.slice(0, 6); }
      for (const l of shownOut) { term.writeln(C.box + "│ " + C.reset + C.secondary + l.slice(0, 150) + C.reset); autoScroll(); }
      for (const l of shownErr) { term.writeln(C.box + "│ " + C.reset + C.red + l.slice(0, 150) + C.reset); autoScroll(); }
      if (hidden > 0) { term.writeln(C.box + "│ " + C.reset + C.muted + "… " + hidden + " satır gizlendi (tamamı: " + all + ")" + C.reset); }
      const ok = result.exit_code === 0;
      const badge = ok ? C.green + "[SUCCESS]" + C.reset + C.muted + " · " + elapsed + "s" + C.reset : C.red + "[FAILED]" + C.reset + C.muted + " · " + elapsed + "s" + C.reset;
      term.writeln(C.box + "└" + C.reset + "─".repeat(34) + " " + badge + " " + C.box + "─┘" + C.reset);
      autoScroll();
    } else {
      const target = params.path || params.url || params.pattern || "";
      term.writeln(C.green + "✓ " + C.reset + C.secondary + toolId + C.reset + (target ? C.muted + "  " + target.slice(0, 60) + C.reset : "") + C.muted + "  (" + elapsed + "s)" + C.reset);
      if (toolId === "read_file") {
        const lines = String(result.content || "").split("\n");
        for (const l of lines.slice(0, 60)) term.writeln(C.secondary + l + C.reset);
        if (lines.length > 60) term.writeln(C.muted + "... (" + (lines.length - 60) + " satır daha)" + C.reset);
      } else if (toolId === "list_dir") {
        for (const e of result.entries || []) {
          term.writeln((e.is_dir ? C.primary + e.name + "/" : C.secondary + e.name) + C.reset);
        }
      } else if (toolId === "search_code") {
        for (const mt of result.matches || []) {
          term.writeln(C.secondary + mt.file + ":" + mt.line + C.reset + " " + C.primary + mt.text + C.reset);
        }
        if ((result.matches || []).length === 0) term.writeln(C.muted + "(eşleşme yok)" + C.reset);
      } else {
        if (result.message) term.writeln(C.secondary + result.message + C.reset);
      }
    }
    term.writeln("");
    autoScroll();
    return buildToolSummary(toolId, result);
  } catch (e) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (isCmd) {
      term.writeln(C.box + "└" + C.reset + "─".repeat(34) + " " + C.red + "[FAILED]" + C.reset + C.muted + " · " + elapsed + "s" + C.reset + " " + C.box + "─┘" + C.reset);
      term.writeln(C.box + "│ " + C.reset + C.red + String(e).slice(0, 150) + C.reset);
    } else {
      term.writeln(C.muted + "✗ " + toolId + ": " + C.reset + C.secondary + e + C.reset);
    }
    term.writeln("");
    autoScroll();
    return "HATA: " + e;
  }
}

// NATIVE tool çağrısını işle — call: {id, name, arguments}
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
    term.writeln(C.muted + "hata: " + C.reset + C.secondary + e + C.reset);
    return "HATA: " + e;
  }

  if (check.decision === "deny") {
    term.writeln(C.muted + "⛔ engellendi: " + C.reset + C.secondary + check.reason + C.reset);
    term.writeln("");
    return "ENGELLENDİ: " + check.reason;
  }
  if (check.decision === "allow") {
    return await executeTool(toolId, params, true);
  }

  const decision = await showApproval(toolId, params, check.risk || risk);
  if (decision === "deny") {
    term.writeln(C.muted + "⛔ reddedildi: " + C.reset + C.secondary + toolId + C.reset);
    term.writeln("");
    return "KULLANICI REDDETTİ";
  }
  return await executeTool(toolId, params, true);
}

// ===== FAZ 5: NATIVE CHAT — ReAct döngüsü =====
async function sendChat(message) {
  if (!invoke) return;
  cmdInput.disabled = true;
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
    } catch (e) {}

    let history = [
      { role: "system", content: buildSystemPrompt(config, homeDir) },
      { role: "user", content: message },
    ];
    const maxTurns = 30;
    const isShortPrompt = message.trim().length < 24;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (!isShortPrompt && estimateTokens(history) > compactThresholdFor(config)) {
        history = compactHistory(history);
        term.writeln(C.muted + "[SYSTEM: bağlam sıkıştırıldı — eski çıktılar özetlendi]" + C.reset);
      }

      const thinkStart = Date.now();
      term.writeln(C.think + "│  Düşünüyor..." + C.reset);

      const reply = await invoke("chat_completion", { config, messages: history });
      const thinkMs = Date.now() - thinkStart;
      updateTokenCounter(history, reply);

      term.write("\x1b[1A\x1b[2K");
      term.writeln(C.think + "> Düşünüyor... " + C.reset + C.muted + "[" + C.reset + C.secondary + (thinkMs / 1000).toFixed(1) + "s" + C.reset + C.muted + "]" + C.reset);

      const text = String(reply.text || "");
      const toolCalls = reply.tool_calls || [];

      if (text.trim()) {
        await typeText(text);
      }

      if (toolCalls.length === 0) {
        break;
      }

      const results = [];
      for (const call of toolCalls) {
        const res = await processToolItem(call);
        results.push("[tool:" + call.name + "] " + (res || ""));
      }

      history.push({
        role: "assistant",
        content: text || "",
        toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
      });
      for (let i = 0; i < toolCalls.length; i++) {
        history.push({ role: "tool", toolCallId: toolCalls[i].id, content: results[i] || "" });
      }
    }
    term.writeln("");
  } catch (e) {
    term.writeln(C.muted + "hata: " + C.reset + C.secondary + e + C.reset);
  } finally {
    cmdInput.disabled = false;
    cmdInput.focus();
  }
}

// ===== Komut çalıştırma — sadece "/" ile başlayan komutlar =====
async function runCommand(cmd) {
  const trimmed = cmd.trim();

  // Slash'sız yazım �  sessiz geç (komut sistemi kaldırıldı)
  if (!trimmed.startsWith("/")) {
    return;
  }

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

      case "undo":
        try {
          const undoMsg = await invoke("undo_last");
          term.writeln(C.green + "↩ " + C.reset + C.secondary + undoMsg + C.reset);
        } catch (e) {
          term.writeln(C.muted + "undo: " + C.reset + C.secondary + e + C.reset);
        }
        break;

      case "permissions":
        // Mod seçim menüsü — kullanıcının isteği: /permissions -> mod menüsü
        openModeMenu();
        break;

      case "context":
        if (args[0]) {
          const val = parseFloat(args[0].replace(",", "."));
          if (!isNaN(val) && val > 0 && val <= 1) {
            // Oran: 0.8 = %80
            if (!configCache) configCache = {};
            configCache.contextRatio = val;
            persistConfigCache();
            try {
              await invoke("save_config", { config: configCache });
            } catch (e) {}
            term.writeln(
              C.green + "✓ context oranı: " + C.reset + C.primary + val + C.reset +
              C.muted + " (" + Math.round(val * 100) + "%) — eşik: " + Math.floor(contextLimitOf(configCache) * val) + C.reset
            );
          } else if (!isNaN(val) && val >= 8000 && val <= 4000000) {
            // Mutlak limit: 1000000 gibi
            if (!configCache) configCache = {};
            configCache.contextLimit = Math.floor(val);
            persistConfigCache();
            try {
              await invoke("save_config", { config: configCache });
            } catch (e) {}
            term.writeln(
              C.green + "✓ context limit: " + C.reset + C.primary + Math.floor(val) + C.reset +
              C.muted + " (eşik: " + Math.floor(val * contextRatioOf(configCache)) + ")" + C.reset
            );
          } else {
            term.writeln(C.muted + "geçersiz — 0-1 arası oran (0.8 = %80) veya 8000-4000000 arası limit girin" + C.reset);
          }
        } else {
          const limit = contextLimitOf(configCache);
          const ratio = contextRatioOf(configCache);
          term.writeln(
            C.primary + "context: " + C.reset + C.secondary + "limit " + limit + C.reset +
            C.muted + " · " + C.reset + C.secondary + "oran " + ratio + C.reset +
            C.muted + " (" + Math.round(ratio * 100) + "%)" + C.reset +
            C.muted + " · " + C.reset + C.secondary + "eşik " + Math.floor(limit * ratio) + C.reset +
            C.muted + " — config.json'dan contextLimit / contextRatio ile değiştirilebilir" + C.reset
          );
        }
        break;

      case "clear":
        term.clear();
        break;

      default:
        // Slash'lı ama tanınmayan komut �  hata
        term.writeln(C.muted + "bilinmeyen komut: " + C.reset + C.primary + rawName + C.reset);
        break;
    }
  } catch (e) {
    term.writeln(C.muted + "hata: " + C.reset + C.secondary + e + C.reset);
  }
}

// ===== Resize handling =====
window.addEventListener("resize", () => {
  fitAddon.fit();
});

// ===== Init � config var mı? =====
async function init() {
  // localStorage'dan cache yükle  get_config hata verse bile hazır
  loadConfigCache();

  if (!invoke) {
    // Tauri API yok � provider seçimi göster
    modalAllItems = Object.values(PROVIDER_REGISTRY).map((p) => ({ id: p.id, name: p.name, provider: p }));
    openModal("providers");
    return;
  }
  try {
    const config = await invoke("get_config");
    const hasConfig = config && config.apiKey;
    if (hasConfig) {
      isInitialized = true;
      configCache = config;
      persistConfigCache();
      updateModelLabel(config.model);
      const p = PROVIDER_REGISTRY[config.provider];
      if (p) providerNameCache = p.name;
    } else {
      // Dosyada yok ama cache'te var mı?
      if (configCache && configCache.apiKey) {
        isInitialized = true;
        updateModelLabel(configCache.model);
        const p = PROVIDER_REGISTRY[configCache.provider];
        if (p) providerNameCache = p.name;
      } else {
        // İlk kurulum � provider seçimi
        modalAllItems = Object.values(PROVIDER_REGISTRY).map((p) => ({ id: p.id, name: p.name, provider: p }));
        openModal("providers");
      }
    }
  } catch (e) {
    // get_config hata verdi  cache varsa devam, yoksa kurulum
    if (configCache && configCache.apiKey) {
      isInitialized = true;
      updateModelLabel(configCache.model);
      const p = PROVIDER_REGISTRY[configCache.provider];
      if (p) providerNameCache = p.name;
    } else {
      modalAllItems = Object.values(PROVIDER_REGISTRY).map((p) => ({ id: p.id, name: p.name, provider: p }));
      openModal("providers");
    }
  }
}

init();


