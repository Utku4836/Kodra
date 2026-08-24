import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import {
  RUNTIME_PERFORMANCE_BUDGETS,
  createFrameCoalescer,
} from "../src/performance-runtime.js";
import { createMotionRuntime, createSelectionController } from "../src/ui-motion.js";
import { createStreamingMarkdownPresenter } from "../src/markdown-ui.js";
import { createTranscriptVirtualizer } from "../src/transcript-virtualizer.js";

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

function measureTranscriptVirtualization(items = 1000) {
  const dom = new JSDOM("<!doctype html><body><main id='scroll'><div id='log'></div></main></body>");
  const scroll = dom.window.document.getElementById("scroll");
  const log = dom.window.document.getElementById("log");
  Object.defineProperty(scroll, "clientHeight", { value: 720 });
  log.getBoundingClientRect = () => ({ top: 0, bottom: items * 72, height: items * 72 });
  for (let index = 0; index < items; index += 1) {
    const row = dom.window.document.createElement("div");
    row.getBoundingClientRect = () => ({ top: index * 72, bottom: index * 72 + 56, height: 56 });
    log.appendChild(row);
  }
  const queue = [];
  const virtualizer = createTranscriptVirtualizer({
    container: log,
    scrollRoot: scroll,
    threshold: 80,
    maxOperationsPerFrame: 6,
    requestFrame: (callback) => { queue.push(callback); return queue.length; },
  });
  const start = performance.now();
  virtualizer.capture();
  const initialFrames = [];
  while (queue.length) {
    const frameStart = performance.now();
    queue.shift()();
    initialFrames.push(performance.now() - frameStart);
  }
  const initialMs = performance.now() - start;
  scroll.scrollTop = 30_000;
  virtualizer.schedule();
  const scrollFrames = [];
  while (queue.length) {
    const frameStart = performance.now();
    queue.shift()();
    scrollFrames.push(performance.now() - frameStart);
  }
  const result = {
    items,
    mounted: virtualizer.mountedCount,
    initialMs: Number(initialMs.toFixed(2)),
    initialMaxFrameMs: Number(Math.max(...initialFrames).toFixed(3)),
    cachedScrollMaxFrameMs: Number(Math.max(...scrollFrames).toFixed(3)),
  };
  dom.window.close();
  return result;
}

function measureStreamingMarkdown(characters = 12_000, updates = 400) {
  const dom = new JSDOM("<!doctype html><body><article id='response' class='rich-message'></article></body>");
  const root = dom.window.document.getElementById("response");
  const paragraph = "## Live response\n\nA **formatted** paragraph with `inline code` and a stable rhythm.\n\n- one\n- two\n\n";
  const source = paragraph.repeat(Math.ceil(characters / paragraph.length)).slice(0, characters);
  const presenter = createStreamingMarkdownPresenter(root, { renderIntervalMs: 40 });
  const start = performance.now();
  for (let index = 1; index <= updates; index += 1) {
    presenter.update(source.slice(0, Math.ceil(source.length * index / updates)));
  }
  presenter.flush(source);
  const totalMs = performance.now() - start;
  const result = {
    characters: source.length,
    updates,
    renders: presenter.metrics.renderCount,
    committedBlocks: presenter.metrics.committedBlocks,
    totalMs: Number(totalMs.toFixed(2)),
  };
  presenter.destroy();
  dom.window.close();
  return result;
}

console.log(JSON.stringify({
  environment: "jsdom-structural (GPU/FPS ölçümü değildir)",
  longSessionMount: measureLongSessionMount(),
  eventCoalescing: measureEventCoalescing(),
  menuRetargeting: measureMenuRetargeting(),
  transcriptVirtualization: measureTranscriptVirtualization(),
  streamingMarkdown: measureStreamingMarkdown(),
}, null, 2));
