import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  UI_MOTION,
  animateElementGroup,
  createMotionRuntime,
  createSelectionController,
  createSelectionInputController,
  createVisibilityController,
  resolveMotionPreference,
  sampleRefreshRate,
} from "../src/ui-motion.js";

function fakeAnimation() {
  let finish;
  let reject;
  const finished = new Promise((resolve, rejectPromise) => { finish = resolve; reject = rejectPromise; });
  return {
    finished,
    cancel() { reject(new Error("cancelled")); },
    finish() { finish(); },
    resolve: finish,
  };
}

test("uygulama full motion tercihi sistem reduced sinyalini bilincli olarak override eder", () => {
  assert.deepEqual(resolveMotionPreference(true, "full"), { preference: "full", reduced: false });
  assert.deepEqual(resolveMotionPreference(true, "system"), { preference: "system", reduced: true });
  assert.deepEqual(resolveMotionPreference(false, "reduced"), { preference: "reduced", reduced: true });
});

test("motion runtime ayni elementte eski animasyonu iptal edip yenisini retarget eder", async () => {
  const dom = new JSDOM("<div id='x'></div>");
  const element = dom.window.document.getElementById("x");
  const animations = [];
  const runtime = createMotionRuntime({
    reducedMotion: () => false,
    animate: () => { const animation = fakeAnimation(); animations.push(animation); return animation; },
  });
  const first = runtime.play(element, [{ opacity: 0 }, { opacity: 1 }]);
  const second = runtime.play(element, [{ opacity: 1 }, { opacity: 0 }]);
  assert.equal(animations.length, 2);
  animations[1].resolve();
  assert.equal((await first).cancelled, true);
  assert.equal((await second).cancelled, false);
  assert.equal(element.style.willChange, "");
});

test("kalici motion bitis stilini cancel oncesi commit eder", async () => {
  const dom = new JSDOM("<div id='x'></div>");
  const element = dom.window.document.getElementById("x");
  const animation = fakeAnimation();
  let committed = false;
  animation.commitStyles = () => {
    committed = true;
    element.style.opacity = "1";
    element.style.transform = "translateY(0px)";
  };
  const runtime = createMotionRuntime({
    reducedMotion: () => false,
    animate: () => animation,
  });
  const running = runtime.play(element, [
    { opacity: 0, transform: "translateY(8px)" },
    { opacity: 1, transform: "translateY(0px)" },
  ], { duration: UI_MOTION.fast, persist: true });
  animation.resolve();
  await running;
  assert.equal(committed, true);
  assert.equal(element.style.opacity, "1");
  assert.equal(element.style.transform, "translateY(0px)");
});

test("visibility controller timeout yerine animation completion ile gizler", async () => {
  const dom = new JSDOM("<div id='root' style='display:none'><div id='surface'></div></div>");
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  const root = dom.window.document.getElementById("root");
  const surface = dom.window.document.getElementById("surface");
  const animations = [];
  const runtime = createMotionRuntime({ animate: () => { const animation = fakeAnimation(); animations.push(animation); return animation; } });
  const controller = createVisibilityController(runtime, { root, surface });
  const opening = controller.open();
  animations.splice(0).forEach((animation) => animation.resolve());
  await opening;
  assert.equal(controller.state, "open");
  assert.equal(root.style.opacity, "1");
  assert.match(surface.style.transform, /translateY\(0\)/);
  const closing = controller.close();
  animations.splice(0).forEach((animation) => animation.resolve());
  await closing;
  assert.equal(root.style.display, "none");
  assert.equal(controller.state, "hidden");
  assert.equal(root.style.opacity, "0");
});

test("menu icerik koreografisi gorunur gecikmeleri runtime'a aktarir", async () => {
  const dom = new JSDOM("<div id='root'><div></div><div></div><div></div></div>");
  const elements = [...dom.window.document.getElementById("root").children];
  const timings = [];
  const animations = [];
  const runtime = createMotionRuntime({
    reducedMotion: () => false,
    animate: (_element, _frames, timing) => {
      timings.push(timing);
      const animation = fakeAnimation();
      animations.push(animation);
      return animation;
    },
  });
  animateElementGroup(runtime, elements, { delay: 40, stagger: 20 });
  assert.deepEqual(timings.map((timing) => timing.delay), [40, 60, 80]);
  animations.forEach((animation) => animation.resolve());
  await Promise.all(animations.map((animation) => animation.finished));
});

test("secim controller mevcut chevronu korur ve yalniz eski yeni satiri degistirir", () => {
  const dom = new JSDOM("<div id='list'><div></div><div></div><div></div></div>");
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  const container = dom.window.document.getElementById("list");
  const rows = [...container.children];
  rows.forEach((row, index) => {
    Object.defineProperty(row, "offsetTop", { value: index * 30 });
    Object.defineProperty(row, "offsetHeight", { value: 30 });
  });
  const runtime = createMotionRuntime({ reducedMotion: () => true });
  const selection = createSelectionController(runtime, { container });
  selection.setRows(rows);
  selection.moveTo(0, { immediate: true });
  selection.moveTo(2);
  assert.equal(selection.marker.textContent, "›");
  assert.equal(rows[0].classList.contains("active"), false);
  assert.equal(rows[1].classList.contains("active"), false);
  assert.equal(rows[2].classList.contains("active"), true);
  assert.match(selection.marker.style.transform, /75px/);
});

test("yuz hizli secim girdisi kuyruk olusturmadan son hedefte biter", () => {
  const dom = new JSDOM("<div id='list'></div>");
  const container = dom.window.document.getElementById("list");
  const rows = Array.from({ length: 120 }, (_, index) => {
    const row = dom.window.document.createElement("div");
    Object.defineProperty(row, "offsetTop", { value: index * 30 });
    Object.defineProperty(row, "offsetHeight", { value: 30 });
    container.appendChild(row);
    return row;
  });
  const runtime = createMotionRuntime({ reducedMotion: () => true });
  const selection = createSelectionController(runtime, { container });
  selection.setRows(rows);
  for (let index = 0; index < 100; index += 1) selection.moveTo(index);
  assert.equal(selection.activeIndex, 99);
  assert.equal(rows.filter((row) => row.classList.contains("active")).length, 1);
  assert.equal(rows[99].getAttribute("aria-selected"), "true");
});

test("klavye secimi sabit pointer altinda mouseenter ile ele gecirilemez", () => {
  const dom = new JSDOM("<div id='list'></div>");
  const container = dom.window.document.getElementById("list");
  const ownership = createSelectionInputController(container, { threshold: 3 });
  container.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX: 40, clientY: 50 }));
  ownership.claimKeyboard();
  assert.equal(ownership.acceptsPointer(), false);
  assert.equal(container.dataset.inputOwner, "keyboard");

  // Scroll/layout kaynaklı row mouseenter pointer konumunu değiştirmez.
  assert.equal(ownership.acceptsPointer(), false);
  container.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX: 45, clientY: 50 }));
  assert.equal(ownership.acceptsPointer(), true);
  assert.equal(container.dataset.inputOwner, "pointer");
});

test("reduced motion sureyi en fazla 60ms yapar", async () => {
  const dom = new JSDOM("<div id='x'></div>");
  const element = dom.window.document.getElementById("x");
  let timing;
  const animation = fakeAnimation();
  const runtime = createMotionRuntime({
    reducedMotion: () => true,
    animate: (_element, _frames, value) => { timing = value; return animation; },
  });
  const running = runtime.play(element, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: UI_MOTION.dialog });
  animation.resolve();
  await running;
  assert.ok(timing.duration <= 60);
  assert.equal(timing.delay, 0);
});

test("normal motion gercek stagger gecikmesini Web Animations API'ye iletir", async () => {
  const dom = new JSDOM("<div id='x'></div>");
  const element = dom.window.document.getElementById("x");
  let timing;
  const animation = fakeAnimation();
  const runtime = createMotionRuntime({
    reducedMotion: () => false,
    animate: (_element, _frames, value) => { timing = value; return animation; },
  });
  const running = runtime.play(element, [{ opacity: 0 }, { opacity: 1 }], {
    duration: UI_MOTION.panel,
    delay: UI_MOTION.stagger * 3,
  });
  animation.resolve();
  await running;
  assert.equal(timing.delay, UI_MOTION.stagger * 3);
  assert.equal(timing.duration, UI_MOTION.panel);
});

test("refresh rate orneklemesi frame timestamp medyanini kullanir", async () => {
  const timestamps = [0, 4.16, 8.32, 12.48, 16.64, 20.8];
  const result = await sampleRefreshRate({
    samples: 5,
    requestFrame: (callback) => queueMicrotask(() => callback(timestamps.shift())),
  });
  assert.equal(result.hz, 240);
  assert.equal(result.samples, 5);
});
