import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  RESPONSE_MOTION_PROFILE,
  charactersPerSecond,
  createResponseMotionController,
  nextRevealBoundary,
  phrasePause,
  responsePacing,
} from "../src/response-motion.js";

function motionFixture(wait = async () => {}) {
  const dom = new JSDOM("<!doctype html><body><div id='response'></div></body>");
  const element = dom.window.document.getElementById("response");
  const waits = [];
  const controller = createResponseMotionController({
    element,
    wait: async (ms) => {
      waits.push(ms);
      await wait(ms);
    },
  });
  return { dom, element, controller, waits };
}

test("catch-up karakter adimlari bounded ve frame hizina yakindir", () => {
  const cases = [
    responsePacing(4000, false, 4000),
    responsePacing(4000, true, 4000),
    responsePacing(1400, true, 1400),
    responsePacing(500, true, 500),
    responsePacing(80, true, 80),
  ];
  assert.ok(Math.max(...cases.map(charactersPerSecond)) < 300);
  assert.deepEqual(cases[0], { characters: 4, delay: 17 });
  assert.deepEqual(cases[1], { characters: 5, delay: 17 });
});

test("karakter akisi unicode karakteri bolmez ve noktalamada durur", () => {
  const value = "A😀B, devam";
  assert.equal(value.slice(0, nextRevealBoundary(value, 0, 2)), "A😀");
  assert.equal(value.slice(0, nextRevealBoundary(value, 0, 8)), "A😀B,");
});

test("noktalama ve paragraf sonlari okunabilir ritim kazanir", () => {
  assert.equal(phrasePause("devam "), 0);
  assert.equal(phrasePause("bekle, "), RESPONSE_MOTION_PROFILE.clausePause);
  assert.equal(phrasePause("tamam. "), RESPONSE_MOTION_PROFILE.sentencePause);
  assert.equal(phrasePause("yeni paragraf\n\n"), RESPONSE_MOTION_PROFILE.paragraphPause);
});

test("tek parca hizli provider cevabi cok sayida kucuk frame olarak sunulur", async () => {
  const { element, controller, waits } = motionFixture();
  const source = Array.from({ length: 120 }, (_, index) => `kelime${index}`).join(" ");
  controller.append(source);
  const result = await controller.finish();

  assert.equal(result.text, source);
  assert.ok(result.metrics.chunks >= 100);
  assert.ok(waits.length >= 100);
  assert.ok(element.querySelector(".response-flow-tail"));
  assert.ok(element.childNodes.length <= 2);
  assert.equal(element.textContent, source);
});

test("parcalanmis streaming deltalari kayipsiz birlesir", async () => {
  const { element, controller } = motionFixture();
  controller.append("Mer");
  controller.append("haba ");
  controller.append("dunya.\nYeni ");
  controller.append("satir");
  const result = await controller.finish();

  assert.equal(result.text, "Merhaba dunya.\nYeni satir");
  assert.equal(element.textContent, result.text);
  assert.ok(result.metrics.chunks >= 3);
});

test("interrupt ham metni aninda ve eksiksiz geri verir", () => {
  const { controller } = motionFixture();
  controller.append("yarim kalan cevap");
  const result = controller.interrupt();
  assert.equal(result.text, "yarim kalan cevap");
});

test("gercek zamanlayici cevabi tek event-loop turunda bitirmez", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='response'></div></body>");
  const element = dom.window.document.getElementById("response");
  const controller = createResponseMotionController({ element });
  const started = Date.now();
  controller.append("bir iki uc");
  await controller.finish();
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 170, `presentation cok hizli tamamlandi: ${elapsed}ms`);
  assert.ok(element.querySelector(".response-flow-tail"));
  assert.ok(element.textContent.length > 0);
});
