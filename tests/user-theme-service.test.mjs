import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createUserThemeService } from "../src/features/themes/user-theme-service.js";
import { createThemeRegistry, createThemeRuntime } from "../src/themes/index.js";

function runtimeFixture() {
  const dom = new JSDOM("<!doctype html><html data-theme='kodra'></html>", { url: "https://local.test" });
  const runtime = createThemeRuntime({
    documentRef: dom.window.document,
    storage: dom.window.localStorage,
    registry: createThemeRegistry(),
  });
  runtime.restore();
  return { dom, runtime };
}

test("user theme service registers bounded native manifests and restores the stored choice", async () => {
  const { dom, runtime } = runtimeFixture();
  dom.window.localStorage.setItem("kodra-theme", "quiet-blue");
  const calls = [];
  const service = createUserThemeService({
    runtime,
    storage: dom.window.localStorage,
    invoke: async (command) => {
      calls.push(command);
      return {
        directory: "C:/config/themes",
        themes: [{
          id: "quiet-blue",
          label: "Quiet Blue",
          version: 1,
          tokens: { "text.primary": "#eef7ff" },
        }],
        errors: [],
      };
    },
  });

  assert.deepEqual(await service.hydrate(), { loaded: 1, errors: 0, directory: "C:/config/themes" });
  assert.equal(runtime.current.id, "quiet-blue");
  assert.equal(service.current().source, "user");
  assert.deepEqual(calls, ["list_user_themes"]);
});

test("bad manifests are isolated and a failed reload preserves previously registered themes", async () => {
  const { dom, runtime } = runtimeFixture();
  const notices = [];
  let fail = false;
  const service = createUserThemeService({
    runtime,
    storage: dom.window.localStorage,
    announce: (message) => notices.push(message),
    invoke: async () => {
      if (fail) throw new Error("offline");
      return {
        directory: "C:/config/themes",
        themes: [
          { id: "calm", label: "Calm", version: 1, tokens: { "text.primary": "#ffffff" } },
          { id: "unsafe", label: "Unsafe", version: 1, tokens: { "canvas.background": "url(x)" } },
        ],
        errors: [{ fileName: "broken.json", reason: "Invalid JSON" }],
      };
    },
  });

  assert.deepEqual(await service.hydrate({ notify: true }), {
    loaded: 1,
    errors: 2,
    directory: "C:/config/themes",
  });
  assert.equal(runtime.list().some((theme) => theme.id === "calm"), true);
  assert.match(notices.at(-1), /1 custom themes loaded · 2 skipped/);

  fail = true;
  assert.deepEqual(await service.hydrate({ notify: true }), {
    loaded: 1,
    errors: 1,
    directory: "C:/config/themes",
  });
  assert.equal(runtime.list().some((theme) => theme.id === "calm"), true);
});
