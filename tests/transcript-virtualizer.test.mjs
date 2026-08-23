import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createTranscriptVirtualizer } from "../src/transcript-virtualizer.js";

test("long transcripts unmount distant nodes while preserving height and the live tail", () => {
  const dom = new JSDOM("<!doctype html><main id='scroll'><div id='log'></div></main>");
  const scroll = dom.window.document.getElementById("scroll");
  const log = dom.window.document.getElementById("log");
  Object.defineProperty(scroll, "clientHeight", { value: 400 });
  scroll.scrollTop = 0;
  log.getBoundingClientRect = () => ({ top: 0, bottom: 10_000, height: 10_000 });
  for (let index = 0; index < 100; index++) {
    const node = dom.window.document.createElement("div");
    node.textContent = `row ${index}`;
    node.getBoundingClientRect = () => ({ top: index * 100, bottom: index * 100 + 60, height: 60 });
    log.appendChild(node);
  }
  const virtualizer = createTranscriptVirtualizer({ container: log, scrollRoot: scroll, threshold: 10, overscan: 200, keepTail: 3 });
  virtualizer.capture();
  virtualizer.update();
  assert.ok(virtualizer.mountedCount < 30);
  assert.equal(log.querySelectorAll(".transcript-placeholder").length, 100 - virtualizer.mountedCount);
  assert.match(log.lastElementChild.textContent, /row 99/);
});
