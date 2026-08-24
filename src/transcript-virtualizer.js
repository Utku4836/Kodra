export const DEFAULT_VIRTUALIZATION_THRESHOLD = 80;

function nodeSpacing(node) {
  if (node.classList.contains("user-block")) return 20;
  if (node.classList.contains("activity-group")) return 20;
  if (node.classList.contains("assistant-response")) return 20;
  if (node.classList.contains("log-line")) return 6;
  return 0;
}

function estimatedHeight(node) {
  const textLength = String(node.textContent || "").length;
  if (node.classList.contains("activity-group")) return 52;
  if (node.classList.contains("user-block")) return 44 + Math.floor(textLength / 90) * 24;
  if (node.classList.contains("rich-message")) return 64 + Math.floor(textLength / 90) * 24;
  return 32 + Math.floor(textLength / 100) * 20;
}

function frameApi(options = {}) {
  return {
    request: options.requestFrame || globalThis.requestAnimationFrame?.bind(globalThis) || ((callback) => setTimeout(callback, 16)),
    cancel: options.cancelFrame || globalThis.cancelAnimationFrame?.bind(globalThis) || clearTimeout,
  };
}

export function createTranscriptVirtualizer({
  container,
  scrollRoot,
  threshold = DEFAULT_VIRTUALIZATION_THRESHOLD,
  overscan = 1400,
  keepTail = 16,
  maxOperationsPerFrame = Number.POSITIVE_INFINITY,
  requestFrame,
  cancelFrame,
} = {}) {
  if (!container || !scrollRoot) throw new TypeError("Transcript container and scroll root are required");
  const frames = frameApi({ requestFrame, cancelFrame });
  let records = [];
  let frame = 0;
  let measurementsDirty = true;
  let reconcileRequested = false;
  let pendingOperations = [];

  const makeRecord = (node) => ({ node, placeholder: null, top: 0, height: estimatedHeight(node), mounted: true });

  function capture() {
    records = [...container.children]
      .filter((node) => !node.classList.contains("transcript-placeholder"))
      .map(makeRecord);
    measurementsDirty = true;
    schedule();
  }

  function append(node) {
    container.appendChild(node);
    const record = makeRecord(node);
    const previous = records.at(-1);
    record.top = previous ? previous.top + previous.height : 0;
    records.push(record);
    schedule();
    return node;
  }

  function clear() {
    if (frame) frames.cancel(frame);
    frame = 0;
    records = [];
    measurementsDirty = true;
    pendingOperations = [];
    reconcileRequested = false;
    container.replaceChildren();
  }

  function shouldKeepMounted(record, index, activeElement) {
    if (index >= records.length - keepTail) return true;
    const node = record.node;
    return node.classList.contains("open")
      || node.getAttribute("aria-busy") === "true"
      || (activeElement && activeElement !== node.ownerDocument?.body && node.contains?.(activeElement));
  }

  function mount(record) {
    if (record.mounted || !record.placeholder?.isConnected) return;
    record.placeholder.replaceWith(record.node);
    record.mounted = true;
  }

  function unmount(record) {
    if (!record.mounted || !record.node.isConnected) return;
    const rect = record.node.getBoundingClientRect?.();
    record.height = Math.max(1, Math.ceil((rect?.height || record.node.offsetHeight || record.height) + nodeSpacing(record.node)));
    measurementsDirty = true;
    const placeholder = record.node.ownerDocument.createElement("div");
    placeholder.className = "transcript-placeholder";
    placeholder.style.height = `${record.height}px`;
    placeholder.setAttribute("aria-hidden", "true");
    record.node.replaceWith(placeholder);
    record.placeholder = placeholder;
    record.mounted = false;
  }

  function reconcile() {
    pendingOperations = [];
    frame = 0;
    if (records.length <= threshold) {
      records.forEach((record) => {
        if (!record.mounted) pendingOperations.push({ record, mount: true });
      });
      return;
    }
    if (measurementsDirty) {
      let topCursor = 0;
      records.forEach((record) => {
        record.top = topCursor;
        topCursor += record.height;
      });
      measurementsDirty = false;
    }
    const top = Math.max(0, scrollRoot.scrollTop - overscan);
    const bottom = scrollRoot.scrollTop + scrollRoot.clientHeight + overscan;
    const activeElement = container.ownerDocument?.activeElement;
    records.forEach((record, index) => {
      const visible = record.top + record.height >= top && record.top <= bottom;
      const shouldMount = visible || shouldKeepMounted(record, index, activeElement);
      if (shouldMount !== record.mounted) pendingOperations.push({ record, mount: shouldMount });
    });
  }

  function runFrame() {
    frame = 0;
    if (reconcileRequested) {
      reconcileRequested = false;
      reconcile();
    }
    const limit = Math.max(1, Number(maxOperationsPerFrame) || 1);
    const batch = pendingOperations.splice(0, limit);
    batch.forEach(({ record, mount: shouldMount }) => {
      if (shouldMount) mount(record);
      else unmount(record);
    });
    if (reconcileRequested || pendingOperations.length) frame = frames.request(runFrame);
  }

  function update() {
    reconcileRequested = true;
    runFrame();
  }

  function schedule() {
    reconcileRequested = true;
    if (!frame) frame = frames.request(runFrame);
    return frame;
  }

  function invalidate() {
    measurementsDirty = true;
    schedule();
  }

  scrollRoot.addEventListener?.("scroll", schedule, { passive: true });
  globalThis.addEventListener?.("resize", invalidate, { passive: true });

  return {
    append,
    capture,
    clear,
    invalidate,
    schedule,
    update,
    get size() { return records.length; },
    get mountedCount() { return records.filter((record) => record.mounted).length; },
  };
}
