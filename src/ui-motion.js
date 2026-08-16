export const UI_MOTION = Object.freeze({
  instant: 90,
  select: 150,
  fast: 170,
  content: 190,
  panel: 230,
  dialog: 260,
  stagger: 18,
  maxStagger: 126,
});

export const UI_EASING = Object.freeze({
  enter: "cubic-bezier(0.16, 0.82, 0.22, 1)",
  select: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  exit: "cubic-bezier(0.4, 0, 0.7, 0.2)",
});

export function resolveMotionPreference(systemReduced, storedPreference, fallback = "system") {
  const allowed = new Set(["system", "full", "reduced"]);
  const preference = allowed.has(storedPreference) ? storedPreference : fallback;
  return {
    preference,
    reduced: preference === "reduced" || (preference === "system" && Boolean(systemReduced)),
  };
}

function defaultReducedMotion() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false;
}

function frameProperties(frame) {
  return Object.keys(frame || {}).filter((key) => key !== "offset" && key !== "easing" && key !== "composite");
}

function applyFrame(element, frame) {
  for (const property of frameProperties(frame)) {
    element.style[property] = String(frame[property]);
  }
}

export function createMotionRuntime(options = {}) {
  const active = new WeakMap();
  const reducedMotion = options.reducedMotion || defaultReducedMotion;
  const animate = options.animate || ((element, frames, timing) => element.animate(frames, timing));
  let sequence = 0;

  function cancel(element) {
    const current = active.get(element);
    if (!current) return;
    active.delete(element);
    try { current.animation.cancel(); } catch (_) {}
    element.style.willChange = "";
  }

  async function play(element, frames, timing = {}) {
    if (!element || !Array.isArray(frames) || frames.length < 2) return { cancelled: false, reduced: false };
    cancel(element);
    const id = ++sequence;
    const reduced = reducedMotion();
    const finalFrame = frames[frames.length - 1];
    const properties = [...new Set(frames.flatMap(frameProperties))];
    const duration = reduced ? Math.min(60, Number(timing.duration || UI_MOTION.fast)) : Number(timing.duration || UI_MOTION.fast);
    const safeFrames = reduced
      ? frames.map((frame, index) => ({ opacity: index === frames.length - 1 ? finalFrame.opacity ?? 1 : frame.opacity ?? 0.84 }))
      : frames;

    element.style.willChange = properties.filter((property) => property === "opacity" || property === "transform").join(", ");
    if (typeof element.animate !== "function" && !options.animate) {
      Object.assign(element.style, finalFrame);
      element.style.willChange = "";
      return { cancelled: false, reduced };
    }

    const animation = animate(element, safeFrames, {
      duration,
      delay: reduced ? 0 : Math.max(0, Number(timing.delay || 0)),
      easing: timing.easing || UI_EASING.enter,
      fill: "both",
    });
    active.set(element, { id, animation });
    let cancelled = false;
    try {
      await animation.finished;
    } catch (_) {
      cancelled = true;
    }
    const current = active.get(element);
    if (current?.id === id) {
      active.delete(element);
      if (!cancelled && timing.persist) {
        try {
          if (typeof animation.commitStyles !== "function") throw new Error("commitStyles unavailable");
          animation.commitStyles();
        } catch (_) {
          applyFrame(element, finalFrame);
        }
      }
      try { animation.cancel(); } catch (_) {}
      element.style.willChange = "";
    }
    return { cancelled, reduced };
  }

  function finishAll(elements = []) {
    for (const element of elements) {
      const current = active.get(element);
      if (!current) continue;
      try { current.animation.finish(); } catch (_) { cancel(element); }
    }
  }

  return { play, cancel, finishAll, reducedMotion };
}

function computedFrame(element) {
  const style = globalThis.getComputedStyle?.(element);
  return {
    opacity: style?.opacity || "1",
    transform: style?.transform === "none" ? "none" : style?.transform || "none",
  };
}

export function createVisibilityController(runtime, options) {
  const root = options.root;
  const surface = options.surface || root;
  const display = options.display || "flex";
  let state = root?.style?.display === "none" ? "hidden" : "open";
  let generation = 0;

  async function open() {
    if (!root) return;
    const token = ++generation;
    const wasHidden = state === "hidden" || root.style.display === "none";
    state = "opening";
    root.dataset.motionState = state;
    root.style.display = display;
    root.style.pointerEvents = "";
    const rootStart = wasHidden
      ? (options.rootOpenFrom || { opacity: 0 })
      : computedFrame(root);
    const rootMotion = runtime.play(root, [rootStart, options.rootOpenTo || { opacity: 1 }], {
      duration: options.openDuration || UI_MOTION.panel,
      easing: UI_EASING.enter,
      persist: true,
    });
    const motions = [rootMotion];
    if (surface !== root) {
      const current = wasHidden
        ? { opacity: 0, transform: "translateY(18px) scale(0.965)" }
        : computedFrame(surface);
      motions.push(runtime.play(surface, [current, { opacity: 1, transform: "translateY(0) scale(1)" }], {
        duration: options.surfaceOpenDuration || UI_MOTION.panel,
        easing: UI_EASING.enter,
        persist: true,
      }));
    }
    await Promise.all(motions);
    if (token !== generation) return;
    state = "open";
    root.dataset.motionState = state;
  }

  async function close() {
    if (!root || state === "hidden") return;
    const token = ++generation;
    state = "closing";
    root.dataset.motionState = state;
    root.style.pointerEvents = "none";
    const motions = [runtime.play(root, [computedFrame(root), options.rootCloseTo || { opacity: 0 }], {
      duration: options.closeDuration || UI_MOTION.fast,
      easing: UI_EASING.exit,
      persist: true,
    })];
    if (surface !== root) {
      motions.push(runtime.play(surface, [computedFrame(surface), {
        opacity: 0,
        transform: "translateY(10px) scale(0.98)",
      }], {
        duration: options.surfaceCloseDuration || UI_MOTION.fast,
        easing: UI_EASING.exit,
        persist: true,
      }));
    }
    await Promise.all(motions);
    if (token !== generation) return;
    root.style.display = "none";
    root.style.pointerEvents = "";
    state = "hidden";
    root.dataset.motionState = state;
  }

  function finish() {
    runtime.finishAll(surface === root ? [root] : [root, surface]);
  }

  return {
    open,
    close,
    finish,
    get state() { return state; },
    get visible() { return state !== "hidden"; },
  };
}

export function createSelectionController(runtime, options) {
  const container = options.container;
  const marker = container.ownerDocument.createElement("span");
  marker.className = options.markerClass || "menu-selection-chevron";
  marker.textContent = "›";
  marker.setAttribute("aria-hidden", "true");
  marker.hidden = true;
  let rows = [];
  let activeIndex = -1;

  function ensureMarker() {
    if (!marker.isConnected) container.appendChild(marker);
  }

  function setRows(nextRows) {
    rows = Array.from(nextRows || []);
    activeIndex = -1;
    ensureMarker();
  }

  function moveTo(index, motionOptions = {}) {
    const next = rows[index];
    if (!next) return null;
    ensureMarker();
    const previous = rows[activeIndex];
    if (previous && previous !== next) {
      previous.classList.remove("active");
      previous.setAttribute("aria-selected", "false");
    }
    next.classList.add("active");
    next.setAttribute("aria-selected", "true");
    const targetY = next.offsetTop + next.offsetHeight / 2;
    const targetTransform = `translate3d(0, ${targetY}px, 0) translateY(-50%)`;
    marker.hidden = false;
    const shouldAnimate = activeIndex >= 0
      && activeIndex !== index
      && !motionOptions.immediate
      && !runtime.reducedMotion();

    runtime.cancel(marker);
    marker.classList.toggle("is-animated", shouldAnimate);
    marker.style.opacity = "1";
    marker.style.transform = targetTransform;
    activeIndex = index;
    return next;
  }

  function reset() {
    runtime.cancel(marker);
    for (const row of rows) {
      row.classList.remove("active");
      row.setAttribute("aria-selected", "false");
    }
    rows = [];
    activeIndex = -1;
    marker.hidden = true;
  }

  return { setRows, moveTo, reset, marker, get activeIndex() { return activeIndex; } };
}

export function createSelectionInputController(container, options = {}) {
  const threshold = Math.max(1, Number(options.threshold || 3));
  let owner = "pointer";
  let pointer = null;
  let keyboardOrigin = null;

  function reflect() {
    if (container) container.dataset.inputOwner = owner;
  }

  function claimKeyboard() {
    owner = "keyboard";
    keyboardOrigin = pointer ? { ...pointer } : null;
    reflect();
  }

  function claimPointer() {
    owner = "pointer";
    keyboardOrigin = null;
    reflect();
  }

  function onPointerMove(event) {
    const next = { x: Number(event.clientX || 0), y: Number(event.clientY || 0) };
    pointer = next;
    if (owner !== "keyboard") return;
    if (!keyboardOrigin) {
      keyboardOrigin = next;
      return;
    }
    if (Math.hypot(next.x - keyboardOrigin.x, next.y - keyboardOrigin.y) >= threshold) {
      claimPointer();
    }
  }

  container?.addEventListener("pointermove", onPointerMove, { passive: true });
  reflect();
  return {
    claimKeyboard,
    claimPointer,
    acceptsPointer: () => owner === "pointer",
    get owner() { return owner; },
  };
}

export function animateVisibleRows(runtime, rows, maxRows = 8) {
  if (runtime.reducedMotion()) return;
  Array.from(rows || []).slice(0, maxRows).forEach((row, index) => {
    void runtime.play(row, [
      { opacity: 0.18, transform: "translateY(10px) scale(0.99)" },
      { opacity: 1, transform: "translateY(0)" },
    ], {
      duration: UI_MOTION.content,
      delay: Math.min(index * UI_MOTION.stagger, UI_MOTION.maxStagger),
      easing: UI_EASING.enter,
    });
  });
}

export function animateElementGroup(runtime, elements, options = {}) {
  if (runtime.reducedMotion()) return;
  const maxItems = options.maxItems || 12;
  const distance = options.distance || 10;
  const baseDelay = options.delay || 36;
  Array.from(elements || []).filter(Boolean).slice(0, maxItems).forEach((element, index) => {
    void runtime.play(element, [
      { opacity: 0, transform: `translateY(${distance}px)` },
      { opacity: 1, transform: "translateY(0)" },
    ], {
      duration: options.duration || UI_MOTION.content,
      delay: baseDelay + Math.min(index * (options.stagger || UI_MOTION.stagger), UI_MOTION.maxStagger),
      easing: UI_EASING.enter,
    });
  });
}

export async function sampleRefreshRate(options = {}) {
  const requestFrame = options.requestFrame || globalThis.requestAnimationFrame?.bind(globalThis);
  const samples = Math.max(4, Math.min(30, options.samples || 16));
  if (typeof requestFrame !== "function") return null;
  const timestamps = [];
  await new Promise((resolve) => {
    const tick = (timestamp) => {
      timestamps.push(timestamp);
      if (timestamps.length >= samples + 1) resolve();
      else requestFrame(tick);
    };
    requestFrame(tick);
  });
  const deltas = timestamps.slice(1).map((value, index) => value - timestamps[index]).filter((value) => value > 0);
  if (!deltas.length) return null;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  return {
    hz: Math.round(1000 / median),
    frameBudgetMs: Number(median.toFixed(2)),
    samples: deltas.length,
  };
}
