import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  createStreamingMarkdownPresenter,
  highlightCode,
  isSafeExternalUrl,
  looksLikeLocalPath,
  renderMarkdownHtml,
  renderMarkdownInto,
  stableMarkdownBoundary,
  stabilizeMarkdown,
} from "../src/markdown-ui.js";

function fixture() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://app.local/",
  });
  const root = dom.window.document.createElement("div");
  root.className = "rich-message";
  dom.window.document.body.appendChild(root);
  const opened = { external: [], paths: [], notices: [] };
  const actions = {
    openExternal: async (url) => opened.external.push(url),
    openPath: async (path) => opened.paths.push(path),
    notify: (message) => opened.notices.push(message),
  };
  return { dom, root, opened, actions };
}

const settle = (dom) => new Promise((resolve) => dom.window.setTimeout(resolve, 8));

test("live Markdown hides incomplete markers and formats emphasis before the response ends", () => {
  const { root, actions } = fixture();
  const presenter = createStreamingMarkdownPresenter(root, { actions, renderIntervalMs: 0 });
  presenter.update("This is **bold");
  assert.equal(root.querySelector(".md-stream-live strong")?.textContent, "bold");
  assert.doesNotMatch(root.querySelector(".md-stream-live").textContent, /\*\*/);

  presenter.update("This is **bold**, *fluid*, `safe` and ~~quiet");
  assert.equal(root.querySelector(".md-stream-live strong")?.textContent, "bold");
  assert.equal(root.querySelector(".md-stream-live em")?.textContent, "fluid");
  assert.equal(root.querySelector(".md-stream-live code")?.textContent, "safe");
  assert.equal(root.querySelector(".md-stream-live :is(del, s)")?.textContent, "quiet");
  presenter.destroy();
});

test("streaming delimiters remain correct across fragmented provider updates", () => {
  assert.deepEqual(stabilizeMarkdown("A **par", true), { text: "A **par**", incomplete: true });
  assert.deepEqual(stabilizeMarkdown("A **part**", true), { text: "A **part**", incomplete: false });
  assert.deepEqual(stabilizeMarkdown("Use `val", true), { text: "Use `val`", incomplete: true });
  assert.deepEqual(stabilizeMarkdown("Try ***nested", true), { text: "Try ***nested***", incomplete: true });
  assert.equal(stabilizeMarkdown("\\*\\*literal\\*\\*", true).incomplete, false);
});

test("completed paragraphs stay mounted while only the active tail changes", () => {
  const { root, actions } = fixture();
  const presenter = createStreamingMarkdownPresenter(root, { actions, renderIntervalMs: 0 });
  presenter.update("First **block**.\n\nSecond block");
  const first = root.querySelector(".md-stream-block-settled");
  assert.ok(first);
  assert.equal(first.querySelector("strong")?.textContent, "block");
  assert.equal(stableMarkdownBoundary("First.\n\nSecond"), 8);

  presenter.update("First **block**.\n\nSecond block keeps growing.");
  assert.equal(root.querySelector(".md-stream-block-settled"), first);
  assert.match(root.querySelector(".md-stream-live").textContent, /keeps growing/);
  assert.equal(presenter.metrics.committedBlocks, 1);
  presenter.destroy();
});

test("links and path actions stay inert until their live block is committed", () => {
  const { root, actions } = fixture();
  const presenter = createStreamingMarkdownPresenter(root, { actions, renderIntervalMs: 0 });
  presenter.update("[Docs](https://example.com) and `src/main.js`");
  assert.equal(root.querySelector(".md-stream-live a")?.hasAttribute("href"), false);
  assert.equal(root.querySelector(".md-stream-live .md-path")?.disabled, true);

  presenter.update("[Docs](https://example.com) and `src/main.js`\n\n");
  assert.equal(root.querySelector(".md-stream-settled a")?.getAttribute("href"), "https://example.com");
  assert.equal(root.querySelector(".md-stream-settled .md-path")?.disabled, false);
  presenter.destroy();
});

test("live code, headings, lists, callouts and tables use enhanced structures", () => {
  const { root, actions } = fixture();
  const presenter = createStreamingMarkdownPresenter(root, { actions, renderIntervalMs: 0 });
  presenter.update("```js\nconst live = true;");
  assert.ok(root.querySelector(".md-stream-live .md-code-block"));
  assert.equal(root.querySelector(".md-stream-live .md-copy-code").disabled, true);

  presenter.update([
    "```js", "const live = true;", "```", "", "## Structure", "", "- one", "- two", "",
    "> [!NOTE] Streaming", "> Stable blocks", "", "| Key | Value |", "| --- | --- |", "| fps | adaptive |",
  ].join("\n"));
  assert.ok(root.querySelector(".md-stream-settled .md-code-block"));
  assert.ok(root.querySelector("h2"));
  assert.equal(root.querySelectorAll("li").length, 2);
  assert.ok(root.querySelector(".md-callout"));
  assert.ok(root.querySelector(".md-table-wrap"));
  presenter.destroy();
});

test("streaming renderer bounds repaint work and exposes a quiet screen-reader channel", () => {
  const { root, actions } = fixture();
  const presenter = createStreamingMarkdownPresenter(root, { actions, renderIntervalMs: 40 });
  let source = "<img src=x onerror=alert(1)>\n\n";
  for (let index = 0; index < 600; index += 1) {
    source += index % 17 === 0 ? " **word**" : " text";
    presenter.update(source);
  }
  presenter.flush();
  assert.ok(presenter.metrics.renderCount <= 3, `too many renders: ${presenter.metrics.renderCount}`);
  assert.equal(presenter.metrics.sourceLength, source.length);
  assert.equal(root.hasAttribute("aria-live"), false);
  assert.equal(root.querySelector(".md-stream-announcer").getAttribute("aria-live"), "polite");
  assert.equal(root.querySelector("script, [onclick], [style]"), null);
  presenter.destroy();
});

test("URL ve yerel yol sinirlari tehlikeli protokolleri reddeder", () => {
  assert.equal(isSafeExternalUrl("https://example.com/docs"), true);
  assert.equal(isSafeExternalUrl("http://localhost:3000"), true);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("file:///C:/secret.txt"), false);
  assert.equal(looksLikeLocalPath("src/main.js"), true);
  assert.equal(looksLikeLocalPath("C:\\Users\\demo\\file.txt"), true);
  assert.equal(looksLikeLocalPath("/status"), false);
});

test("ham HTML, script, olay niteligi ve uzak resim DOM'a sizamaz", async () => {
  const { dom, root, actions } = fixture();
  renderMarkdownInto(root, [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(2)>",
    "[tehlikeli](javascript:alert(3))",
    "![uzak gorsel](https://tracker.test/pixel.png)",
  ].join("\n\n"), { actions });
  await settle(dom);

  assert.equal(root.querySelector("script, img"), null);
  assert.equal(root.querySelector("[onerror], [onclick], [style]"), null);
  assert.equal(root.querySelector('a[href^="javascript:"]'), null);
  assert.equal(root.querySelectorAll(".md-image-placeholder").length, 1);
  assert.match(root.textContent, /uzak gorsel/);
});

test("harici baglanti yalnizca kullanici tiklamasiyla guvenli eyleme gider", async () => {
  const { dom, root, opened, actions } = fixture();
  renderMarkdownInto(root, "[Tauri belgeleri](https://tauri.app/start/)", { actions });
  const link = root.querySelector(".md-external-link");
  assert.ok(link);
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(opened.external.length, 0);
  link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await settle(dom);
  assert.deepEqual(opened.external, ["https://tauri.app/start/"]);
});

test("kod yuzeyi dil, satir sayisi, vurgulama, kopyalama ve daraltma sunar", async () => {
  const { dom, root, opened, actions } = fixture();
  let copied = "";
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value) => { copied = value; } },
  });
  const source = Array.from({ length: 40 }, (_, index) => `const line${index} = "value";`).join("\n");
  renderMarkdownInto(root, `\`\`\`js src/example.js\n${source}\n\`\`\``, { actions });
  await settle(dom);

  const figure = root.querySelector(".md-code-block");
  assert.ok(figure.classList.contains("is-collapsed"));
  assert.equal(root.querySelector(".md-code-language").textContent, "JavaScript");
  assert.equal(root.querySelector(".md-code-count").textContent, "40 lines");
  assert.equal(root.querySelectorAll(".md-code-line").length, 40);
  assert.ok(root.querySelector(".md-token-keyword"));
  assert.ok(root.querySelector(".md-code-meta.md-path"));

  root.querySelector(".md-copy-code").click();
  await settle(dom);
  assert.equal(copied, `${source}\n`);
  assert.match(opened.notices.at(-1), /copied/i);

  const expand = root.querySelector(".md-expand-code");
  expand.click();
  assert.equal(figure.classList.contains("is-collapsed"), false);
  assert.equal(expand.getAttribute("aria-expanded"), "true");
});

test("short shell blocks use the compact terminal command surface", () => {
  const { root, actions } = fixture();
  renderMarkdownInto(root, "```powershell\nnpm test\n```", { actions });
  const surface = root.querySelector(".md-code-block");
  assert.ok(surface.classList.contains("md-code-command"));
  assert.equal(surface.dataset.lines, "1");
  assert.equal(surface.querySelector(".md-code-language").textContent, "PowerShell");
});

test("diff satirlari anlamini kaybetmeden siniflandirilir", async () => {
  const { dom, root, actions } = fixture();
  renderMarkdownInto(root, "```diff\ndiff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n same\n```", { actions });
  await settle(dom);
  assert.equal(root.querySelectorAll(".md-diff-add").length, 1);
  assert.equal(root.querySelectorAll(".md-diff-delete").length, 1);
  assert.equal(root.querySelectorAll(".md-diff-hunk").length, 1);
  assert.match(root.textContent, /\+new/);
});

test("callout, gorev listesi ve tablo erisilebilir yapilara donusur", () => {
  const { root, actions } = fixture();
  renderMarkdownInto(root, [
    "> [!WARNING] Dikkatli ol",
    "> Geri alinamaz bir adim.",
    "",
    "- [x] Guvenlik testi",
    "- [ ] Gorsel test",
    "",
    "| Faz | Durum |",
    "| --- | --- |",
    "| 5A | Hazir |",
  ].join("\n"), { actions });

  assert.equal(root.querySelector(".md-callout").getAttribute("role"), "alert");
  assert.equal(root.querySelector(".md-callout-title").textContent.trim(), "Dikkatli ol");
  assert.equal(root.querySelectorAll(".md-checkbox").length, 2);
  assert.equal(root.querySelector('.md-checkbox[aria-checked="true"]') !== null, true);
  assert.equal(root.querySelector(".md-table-wrap").getAttribute("role"), "region");
  assert.equal(root.querySelector("th").getAttribute("scope"), "col");
});

test("yerel yollar butona donusur ve kendiliginden acilmaz", async () => {
  const { dom, root, opened, actions } = fixture();
  renderMarkdownInto(root, "Dosya: `src/main.js`", { actions });
  const path = root.querySelector(".md-path");
  assert.ok(path);
  assert.deepEqual(opened.paths, []);
  path.click();
  await settle(dom);
  assert.deepEqual(opened.paths, ["src/main.js"]);
});

test("yarim kalan kod citi akis sirasinda dengelenir", async () => {
  const prepared = stabilizeMarkdown("```js\nconst ready = true;", true);
  assert.equal(prepared.incomplete, true);
  assert.match(prepared.text, /```\n$/);

  const { dom, root, actions } = fixture();
  renderMarkdownInto(root, "```js\nconst ready = true;", { actions, streaming: true });
  await settle(dom);
  assert.equal(root.classList.contains("md-incomplete"), true);
  assert.ok(root.querySelector(".md-code-block"));
});

test("vurgu motoru kaynak metni HTML olarak calistirmaz", () => {
  const html = highlightCode('<script onclick="bad()">const x = 1;</script>', "html");
  assert.doesNotMatch(html, /<script onclick=/);
  assert.match(html, /&lt;script/);

  const dom = new JSDOM("<!doctype html><body></body>");
  const rendered = renderMarkdownHtml("**guvenli** <iframe src=x></iframe>", dom.window.document);
  assert.doesNotMatch(rendered, /<iframe/i);
  assert.match(rendered, /<strong>guvenli<\/strong>/);
});
