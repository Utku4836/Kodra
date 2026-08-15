import markdownit from "./vendor/markdown-it.esm.min.mjs";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_TAGS = new Set([
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "li", "ol", "p", "pre", "s", "span", "strong", "table", "tbody", "td", "th",
  "thead", "tr", "ul",
]);
const ALLOWED_ATTRIBUTES = new Map([
  ["a", new Set(["href", "title"])],
  ["code", new Set(["class"])],
  ["ol", new Set(["start"])],
  ["pre", new Set(["data-language", "data-meta"])],
  ["span", new Set(["class"])],
  ["td", new Set(["colspan", "rowspan"])],
  ["th", new Set(["colspan", "rowspan", "scope"])],
]);
const SAFE_INITIAL_CLASSES = /^(?:language-[a-z0-9_+#.-]+|md-image-placeholder)$/i;
const LONG_CODE_LINES = 36;
const LONG_CODE_CHARS = 3600;

const LANGUAGE_LABELS = {
  bash: "Shell", c: "C", cpp: "C++", cs: "C#", css: "CSS", diff: "Diff", html: "HTML",
  javascript: "JavaScript", js: "JavaScript", json: "JSON", jsx: "JSX", markdown: "Markdown",
  md: "Markdown", plaintext: "Text", powershell: "PowerShell", ps1: "PowerShell", py: "Python",
  python: "Python", rust: "Rust", rs: "Rust", shell: "Shell", sh: "Shell", sql: "SQL",
  text: "Text", ts: "TypeScript", tsx: "TSX", xml: "XML", yaml: "YAML", yml: "YAML",
};

const KEYWORDS = {
  javascript: new Set("as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined".split(" ")),
  typescript: new Set("abstract any as asserts async await bigint boolean break case catch class const constructor continue declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of override private protected public readonly require return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield".split(" ")),
  json: new Set(["true", "false", "null"]),
  rust: new Set("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while".split(" ")),
  python: new Set("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield".split(" ")),
  shell: new Set("case do done elif else esac export fi for function if in local readonly return set shift then trap unset until while".split(" ")),
  powershell: new Set("begin break catch class continue data do dynamicparam else elseif end enum exit filter finally for foreach from function if in param process return switch throw trap try until using var while workflow".split(" ")),
  css: new Set(["important", "inherit", "initial", "none", "revert", "transparent", "unset"]),
  sql: new Set("add alter and as asc begin between by case check column commit constraint create database default delete desc distinct drop else end exists foreign from full grant group having in index inner insert into is join key left like limit not null on or order outer primary references right rollback row select set table then union unique update values view when where with".split(" ")),
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeClassName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9_+#.-]/g, "").slice(0, 40);
}

export function normalizeLanguage(value) {
  const language = safeClassName(value);
  if (["js", "jsx"].includes(language)) return "javascript";
  if (["ts", "tsx"].includes(language)) return "typescript";
  if (["py"].includes(language)) return "python";
  if (["rs"].includes(language)) return "rust";
  if (["bash", "sh", "zsh"].includes(language)) return "shell";
  if (["ps1", "pwsh"].includes(language)) return "powershell";
  if (["html", "xml"].includes(language)) return "markup";
  if (["yml"].includes(language)) return "yaml";
  return language || "text";
}

export function isSafeExternalUrl(value) {
  try {
    const url = new URL(String(value));
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) && Boolean(url.hostname);
  } catch (_) {
    return false;
  }
}

export function looksLikeLocalPath(value) {
  const path = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!path || path.length > 2048 || path.includes("\0") || isSafeExternalUrl(path)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(path) || /^(?:~|\.{1,2})[\\/]/.test(path)) return true;
  if (/^[\\/]{1,2}[^\\/]+[\\/]/.test(path)) return true;
  if (!/[\\/]/.test(path) || /^\/[a-z][a-z0-9-]*$/i.test(path)) return false;
  return /(?:^|[\\/])[^\\/]+\.[a-z0-9]{1,12}(?::\d+)?$/i.test(path)
    || /^(?:src|app|lib|tests?|docs?|scripts?|config|public|assets?|packages?)[\\/]/i.test(path);
}

function markdownLinkAllowed(value) {
  return isSafeExternalUrl(value) || looksLikeLocalPath(value);
}

const renderer = markdownit({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
});

renderer.validateLink = markdownLinkAllowed;
renderer.renderer.rules.image = (tokens, index) => {
  const alt = tokens[index].content || "Image";
  return `<span class="md-image-placeholder">${escapeHtml(alt)}</span>`;
};
renderer.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const info = String(token.info || "").trim();
  const [rawLanguage = "text", ...metaParts] = info.split(/\s+/);
  const language = safeClassName(rawLanguage) || "text";
  const meta = metaParts.join(" ").slice(0, 240);
  return `<pre data-language="${escapeHtml(language)}" data-meta="${escapeHtml(meta)}"><code class="language-${escapeHtml(language)}">${escapeHtml(token.content)}</code></pre>\n`;
};

export function stabilizeMarkdown(value, streaming = false) {
  const source = String(value || "").replace(/\r\n?/g, "\n");
  const fencePattern = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/gm;
  let open = null;
  let match;
  while ((match = fencePattern.exec(source)) !== null) {
    const marker = match[2];
    if (!open) open = { char: marker[0], length: marker.length };
    else if (marker[0] === open.char && marker.length >= open.length) open = null;
  }
  if (!open) return { text: source, incomplete: false };
  return {
    text: `${source}${source.endsWith("\n") ? "" : "\n"}${open.char.repeat(open.length)}\n`,
    incomplete: streaming,
  };
}

export function sanitizeHtml(html, documentRef = globalThis.document) {
  if (!documentRef?.createElement) throw new Error("DOM is unavailable");
  const template = documentRef.createElement("template");
  template.innerHTML = String(html || "");
  const elements = Array.from(template.content.querySelectorAll("*"));
  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      element.replaceWith(documentRef.createTextNode(element.textContent || ""));
      continue;
    }
    const allowed = ALLOWED_ATTRIBUTES.get(tag) || new Set();
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!allowed.has(name) || name.startsWith("on") || name === "style") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href" && !markdownLinkAllowed(attribute.value)) element.removeAttribute("href");
      if (name === "class") {
        const classes = attribute.value.split(/\s+/).filter((entry) => SAFE_INITIAL_CLASSES.test(entry));
        if (classes.length) element.setAttribute("class", classes.join(" "));
        else element.removeAttribute("class");
      }
    }
  }
  return template.content;
}

function languageProfile(language) {
  const normalized = normalizeLanguage(language);
  const keywords = KEYWORDS[normalized] || new Set();
  const lineComment = normalized === "python" || normalized === "shell" || normalized === "powershell" || normalized === "yaml"
    ? "#"
    : normalized === "sql"
      ? "--"
      : ["javascript", "typescript", "rust", "css"].includes(normalized)
        ? "//"
        : "";
  return { normalized, keywords, lineComment };
}

function tokenSpan(type, value) {
  return `<span class="md-token md-token-${type}">${escapeHtml(value)}</span>`;
}

function highlightLine(line, profile) {
  let output = "";
  let cursor = 0;
  while (cursor < line.length) {
    const rest = line.slice(cursor);
    if (profile.lineComment && rest.startsWith(profile.lineComment)) {
      output += tokenSpan("comment", rest);
      break;
    }
    if (rest.startsWith("<!--")) {
      output += tokenSpan("comment", rest);
      break;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      const length = end >= 0 ? end + 2 : rest.length;
      output += tokenSpan("comment", rest.slice(0, length));
      cursor += length;
      continue;
    }
    const char = rest[0];
    if (char === '"' || char === "'" || char === "`") {
      let end = 1;
      while (end < rest.length) {
        if (rest[end] === "\\") end += 2;
        else if (rest[end] === char) { end += 1; break; }
        else end += 1;
      }
      output += tokenSpan("string", rest.slice(0, end));
      cursor += end;
      continue;
    }
    if (profile.normalized === "markup" && char === "<") {
      const end = rest.indexOf(">");
      const length = end >= 0 ? end + 1 : rest.length;
      output += tokenSpan("tag", rest.slice(0, length));
      cursor += length;
      continue;
    }
    const number = rest.match(/^(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i)?.[0];
    if (number) {
      output += tokenSpan("number", number);
      cursor += number.length;
      continue;
    }
    const variable = rest.match(/^\$[a-z_][\w:]*/i)?.[0];
    if (variable) {
      output += tokenSpan("variable", variable);
      cursor += variable.length;
      continue;
    }
    const identifier = rest.match(/^[a-z_$][\w$-]*/i)?.[0];
    if (identifier) {
      output += profile.keywords.has(identifier.toLowerCase()) || profile.keywords.has(identifier)
        ? tokenSpan("keyword", identifier)
        : escapeHtml(identifier);
      cursor += identifier.length;
      continue;
    }
    output += escapeHtml(char);
    cursor += 1;
  }
  return output || "&#8203;";
}

export function highlightCode(code, language) {
  const profile = languageProfile(language);
  return String(code || "")
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `<span class="md-code-line">${highlightLine(line, profile)}</span>`)
    .join("\n");
}

function diffKind(line) {
  if (/^(?:diff --git|index |--- |\+\+\+ )/.test(line)) return "meta";
  if (/^@@/.test(line)) return "hunk";
  if (/^\+/.test(line)) return "add";
  if (/^-/.test(line)) return "delete";
  return "context";
}

function renderDiff(codeElement, source, documentRef) {
  codeElement.className = "md-diff-code";
  const fragment = documentRef.createDocumentFragment();
  source.replace(/\n$/, "").split("\n").forEach((line) => {
    const row = documentRef.createElement("span");
    row.className = `md-code-line md-diff-line md-diff-${diffKind(line)}`;
    row.textContent = line || "\u200b";
    fragment.appendChild(row);
    fragment.appendChild(documentRef.createTextNode("\n"));
  });
  codeElement.replaceChildren(fragment);
}

function idle(callback, windowRef) {
  if (typeof windowRef?.requestIdleCallback === "function") windowRef.requestIdleCallback(callback, { timeout: 450 });
  else windowRef?.setTimeout ? windowRef.setTimeout(callback, 0) : callback();
}

function lazyHighlight(codeElement, source, language) {
  const documentRef = codeElement.ownerDocument;
  const windowRef = documentRef.defaultView || globalThis.window;
  let completed = false;
  const run = () => {
    if (completed || !codeElement.isConnected) return;
    completed = true;
    idle(() => {
      if (!codeElement.isConnected) return;
      codeElement.innerHTML = highlightCode(source, language);
      codeElement.classList.add("is-highlighted");
    }, windowRef);
  };
  if (typeof windowRef?.IntersectionObserver !== "function") {
    run();
    return;
  }
  const observer = new windowRef.IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    run();
  }, { rootMargin: "180px" });
  observer.observe(codeElement);
}

async function copyText(value, documentRef) {
  const windowRef = documentRef.defaultView || globalThis.window;
  if (windowRef?.navigator?.clipboard?.writeText) {
    await windowRef.navigator.clipboard.writeText(value);
    return;
  }
  const textarea = documentRef.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  documentRef.body.appendChild(textarea);
  textarea.select();
  const copied = documentRef.execCommand?.("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard is unavailable");
}

function actionButton(documentRef, label, className) {
  const button = documentRef.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

function enhanceCodeBlocks(root, actions) {
  const documentRef = root.ownerDocument;
  root.querySelectorAll("pre > code").forEach((codeElement) => {
    const pre = codeElement.parentElement;
    if (!pre || pre.closest(".md-code-block")) return;
    const source = codeElement.textContent || "";
    const classLanguage = Array.from(codeElement.classList).find((name) => name.startsWith("language-"))?.slice(9);
    const rawLanguage = pre.dataset.language || classLanguage || "text";
    const language = normalizeLanguage(rawLanguage);
    const meta = String(pre.dataset.meta || "").trim();
    const lineCount = source ? source.replace(/\n$/, "").split("\n").length : 0;
    const isDiff = language === "diff" || /^(?:diff --git|--- .+\n\+\+\+ )/m.test(source);

    const figure = documentRef.createElement("figure");
    figure.className = `md-code-block${isDiff ? " md-code-diff" : ""}`;
    const header = documentRef.createElement("div");
    header.className = "md-code-header";
    const identity = documentRef.createElement("div");
    identity.className = "md-code-identity";
    const label = documentRef.createElement("span");
    label.className = "md-code-language";
    label.textContent = LANGUAGE_LABELS[rawLanguage.toLowerCase()] || LANGUAGE_LABELS[language] || rawLanguage || "Text";
    identity.appendChild(label);
    if (meta) {
      const metaElement = looksLikeLocalPath(meta)
        ? createPathButton(documentRef, meta, actions)
        : documentRef.createElement("span");
      if (!looksLikeLocalPath(meta)) metaElement.textContent = meta;
      metaElement.classList.add("md-code-meta");
      identity.appendChild(metaElement);
    }
    const count = documentRef.createElement("span");
    count.className = "md-code-count";
    count.textContent = lineCount === 1 ? "1 line" : `${lineCount} lines`;
    identity.appendChild(count);

    const controls = documentRef.createElement("div");
    controls.className = "md-code-actions";
    const copy = actionButton(documentRef, "Copy", "md-code-action md-copy-code");
    copy.setAttribute("aria-label", `Copy ${label.textContent} code`);
    copy.addEventListener("click", async () => {
      try {
        await copyText(source, documentRef);
        copy.textContent = "Copied";
        actions?.notify?.("Code copied to clipboard");
        (documentRef.defaultView || globalThis.window)?.setTimeout(
          () => { copy.textContent = "Copy"; },
          1400,
        );
      } catch (error) {
        actions?.notify?.("Could not copy code");
      }
    });
    controls.appendChild(copy);

    const long = lineCount > LONG_CODE_LINES || source.length > LONG_CODE_CHARS;
    if (long) {
      figure.classList.add("is-collapsed");
      const expand = actionButton(documentRef, "Show all", "md-code-action md-expand-code");
      expand.setAttribute("aria-expanded", "false");
      expand.addEventListener("click", () => {
        const collapsed = figure.classList.toggle("is-collapsed");
        expand.textContent = collapsed ? "Show all" : "Collapse";
        expand.setAttribute("aria-expanded", String(!collapsed));
      });
      controls.prepend(expand);
    }

    header.append(identity, controls);
    pre.replaceWith(figure);
    figure.append(header, pre);
    pre.removeAttribute("data-language");
    pre.removeAttribute("data-meta");
    if (isDiff) renderDiff(codeElement, source, documentRef);
    else lazyHighlight(codeElement, source, language);
  });
}

const CALLOUTS = {
  NOTE: ["Note", "note"], INFO: ["Info", "note"], TIP: ["Tip", "note"],
  WARNING: ["Warning", "alert"], CAUTION: ["Caution", "alert"], ERROR: ["Error", "alert"],
  DANGER: ["Danger", "alert"], SUCCESS: ["Success", "status"],
};

function enhanceCallouts(root) {
  root.querySelectorAll("blockquote").forEach((quote) => {
    const first = quote.firstElementChild;
    if (!first || first.tagName !== "P") return;
    const match = first.innerHTML.match(/^\[!(NOTE|INFO|TIP|WARNING|CAUTION|ERROR|DANGER|SUCCESS)\](?:[ \t]+([^<\n]+))?(?:<br\s*\/?>)?/i);
    if (!match) return;
    const kind = match[1].toUpperCase();
    const [defaultTitle, role] = CALLOUTS[kind];
    quote.className = `md-callout md-callout-${kind.toLowerCase()}`;
    quote.setAttribute("role", role);
    first.innerHTML = first.innerHTML.slice(match[0].length);
    if (!first.textContent.trim() && !first.children.length) first.remove();
    const header = quote.ownerDocument.createElement("div");
    header.className = "md-callout-title";
    const marker = quote.ownerDocument.createElement("span");
    marker.className = "md-callout-marker";
    marker.setAttribute("aria-hidden", "true");
    const title = quote.ownerDocument.createElement("span");
    title.textContent = (match[2] || defaultTitle).trim();
    header.append(marker, title);
    quote.prepend(header);
  });
}

function enhanceTasks(root) {
  const documentRef = root.ownerDocument;
  root.querySelectorAll("li").forEach((item) => {
    const walker = documentRef.createTreeWalker(item, 4);
    const node = walker.nextNode();
    if (!node) return;
    const match = node.nodeValue.match(/^\s*\[([ xX])\]\s+/);
    if (!match) return;
    node.nodeValue = node.nodeValue.slice(match[0].length);
    const checked = match[1].toLowerCase() === "x";
    item.classList.add("md-task");
    item.parentElement?.classList.add("md-task-list");
    const checkbox = documentRef.createElement("span");
    checkbox.className = "md-checkbox";
    checkbox.setAttribute("role", "checkbox");
    checkbox.setAttribute("aria-checked", String(checked));
    checkbox.setAttribute("aria-readonly", "true");
    checkbox.setAttribute("aria-label", checked ? "Completed" : "Not completed");
    checkbox.tabIndex = 0;
    item.prepend(checkbox);
  });
}

function createPathButton(documentRef, path, actions) {
  const button = documentRef.createElement("button");
  button.type = "button";
  button.className = "md-path";
  button.textContent = path;
  button.title = "Show in File Explorer";
  button.setAttribute("aria-label", `Show ${path} in File Explorer`);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await actions?.openPath?.(path);
      actions?.notify?.("Path opened");
    } catch (error) {
      actions?.notify?.(`Could not open path: ${String(error)}`);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function enhanceLinksAndPaths(root, actions) {
  const documentRef = root.ownerDocument;
  root.querySelectorAll("code:not(pre code)").forEach((code) => {
    const path = (code.textContent || "").trim();
    if (looksLikeLocalPath(path)) code.replaceWith(createPathButton(documentRef, path, actions));
  });
  root.querySelectorAll("a").forEach((anchor) => {
    const href = anchor.getAttribute("href") || "";
    if (looksLikeLocalPath(href) || (!href && looksLikeLocalPath(anchor.textContent))) {
      anchor.replaceWith(createPathButton(documentRef, href || anchor.textContent.trim(), actions));
      return;
    }
    if (!isSafeExternalUrl(href)) {
      anchor.replaceWith(documentRef.createTextNode(anchor.textContent || href));
      return;
    }
    anchor.classList.add("md-external-link");
    anchor.rel = "noopener noreferrer";
    anchor.target = "_blank";
    const host = new URL(href).hostname.replace(/^www\./, "");
    anchor.title = `Open ${host} in the system browser`;
    anchor.setAttribute("aria-label", `${anchor.textContent || host}, external link`);
    anchor.addEventListener("click", async (event) => {
      event.preventDefault();
      try { await actions?.openExternal?.(href); }
      catch (error) { actions?.notify?.(`Could not open link: ${String(error)}`); }
    });
  });
}

function enhanceTables(root) {
  const documentRef = root.ownerDocument;
  root.querySelectorAll("table").forEach((table) => {
    if (table.parentElement?.classList.contains("md-table-wrap")) return;
    table.querySelectorAll("thead th").forEach((cell) => cell.setAttribute("scope", "col"));
    const wrap = documentRef.createElement("div");
    wrap.className = "md-table-wrap";
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Scrollable table");
    table.replaceWith(wrap);
    wrap.appendChild(table);
  });
}

export function enhanceMarkdown(root, actions = {}) {
  enhanceCallouts(root);
  enhanceTasks(root);
  enhanceLinksAndPaths(root, actions);
  enhanceTables(root);
  enhanceCodeBlocks(root, actions);
}

export function renderMarkdownInto(root, value, options = {}) {
  if (!root) return null;
  const documentRef = root.ownerDocument || globalThis.document;
  const prepared = stabilizeMarkdown(value, Boolean(options.streaming));
  try {
    const fragment = sanitizeHtml(renderer.render(prepared.text), documentRef);
    root.replaceChildren(fragment.cloneNode(true));
    root.classList.toggle("md-incomplete", prepared.incomplete);
    root.classList.remove("md-render-fallback");
    enhanceMarkdown(root, options.actions || {});
  } catch (error) {
    root.textContent = String(value || "");
    root.classList.add("md-render-fallback");
    options.actions?.notify?.("Markdown was displayed as safe plain text");
  }
  return root;
}

export function renderMarkdownHtml(value, documentRef = globalThis.document) {
  const prepared = stabilizeMarkdown(value, false);
  const fragment = sanitizeHtml(renderer.render(prepared.text), documentRef);
  const template = documentRef.createElement("template");
  template.content.appendChild(fragment.cloneNode(true));
  return template.innerHTML;
}
