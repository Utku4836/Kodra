import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import {
  RUNTIME_PERFORMANCE_BUDGETS,
  createFrameCoalescer,
} from "../src/performance-runtime.js";
import { createMotionRuntime, createSelectionController } from "../src/ui-motion.js";

function percentile(samples, ratio) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function measureLongSessionMount(runs = 25) {
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    const dom = new JSDOM("<!doctype html><body><main id='log'></main></body>");
    const log = dom.window.document.getElementById("log");
    const fragment = dom.window.document.createDocumentFragment();
    const start = performance.now();
    for (let index = 0; index < RUNTIME_PERFORMANCE_BUDGETS.longSessionItems; index += 1) {
      const item = dom.window.document.createElement("article");
      item.className = index % 3 === 0 ? "log-item" : "log-line rich-message";
      item.textContent = `runtime sample ${index}`;
      fragment.appendChild(item);
    }
    log.appendChild(fragment);
    samples.push(performance.now() - start);
    dom.window.close();
  }
  return {
    items: RUNTIME_PERFORMANCE_BUDGETS.longSessionItems,
    medianMs: Number(percentile(samples, 0.5).toFixed(2)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
  };
}

function measureEventCoalescing(events = 1000) {
  const queue = [];
  let executed = 0;
  const scheduler = createFrameCoalescer(() => { executed += 1; }, {
    requestFrame: (callback) => { queue.push(callback); return queue.length; },
  });
  const start = performance.now();
  for (let index = 0; index < events; index += 1) scheduler.schedule(index);
  const scheduleMs = performance.now() - start;
  while (queue.length) queue.shift()();
  return { events, frameJobs: executed, scheduleMs: Number(scheduleMs.toFixed(3)) };
}

function measureMenuRetargeting(items = 500, moves = 100) {
  const dom = new JSDOM("<!doctype html><body><div id='list'></div></body>");
  const list = dom.window.document.getElementById("list");
  const rows = [];
  for (let index = 0; index < items; index += 1) {
    const row = dom.window.document.createElement("div");
    Object.defineProperty(row, "offsetTop", { value: index * 32 });
    Object.defineProperty(row, "offsetHeight", { value: 32 });
    list.appendChild(row);
    rows.push(row);
  }
  const runtime = createMotionRuntime({ reducedMotion: () => true });
  const selection = createSelectionController(runtime, { container: list });
  selection.setRows(rows);
  selection.moveTo(0, { immediate: true });
  const samples = [];
  for (let index = 1; index <= moves; index += 1) {
    const start = performance.now();
    selection.moveTo(index % items);
    samples.push(performance.now() - start);
  }
  const activeRows = rows.filter((row) => row.classList.contains("active")).length;
  dom.window.close();
  return {
    items,
    moves,
    activeRows,
    medianMs: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
  };
}

console.log(JSON.stringify({
  environment: "jsdom-structural (GPU/FPS ölçümü değildir)",
  longSessionMount: measureLongSessionMount(),
  eventCoalescing: measureEventCoalescing(),
  menuRetargeting: measureMenuRetargeting(),
}, null, 2));
