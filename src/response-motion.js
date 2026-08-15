export const RESPONSE_MOTION_PROFILE = Object.freeze({
  live: Object.freeze([
    Object.freeze({ above: 2400, characters: 4, delay: 17 }),
    Object.freeze({ above: 900, characters: 3, delay: 17 }),
    Object.freeze({ above: 280, characters: 2, delay: 18 }),
    Object.freeze({ above: -1, characters: 1, delay: 19 }),
  ]),
  complete: Object.freeze([
    Object.freeze({ above: 2400, characters: 5, delay: 17 }),
    Object.freeze({ above: 1000, characters: 4, delay: 17 }),
    Object.freeze({ above: 420, characters: 3, delay: 18 }),
    Object.freeze({ above: -1, characters: 2, delay: 19 }),
  ]),
  paragraphPause: 112,
  sentencePause: 82,
  linePause: 66,
  clausePause: 30,
  finalFlowSettle: 105,
  tailCharacters: 16,
});

function tierFor(pressure, tiers) {
  return tiers.find((tier) => pressure > tier.above) || tiers.at(-1);
}

/**
 * Provider throughput and presentation throughput are intentionally separate.
 * peakBacklog prevents a fast provider from switching to a slow one-word tail
 * immediately after completion, while character-sized paint steps avoid visible chunks.
 */
export function responsePacing(backlog, complete, peakBacklog = backlog, profile = RESPONSE_MOTION_PROFILE) {
  const pressure = complete ? Math.max(backlog, peakBacklog) : backlog;
  const tier = tierFor(Math.max(0, pressure), complete ? profile.complete : profile.live);
  return { characters: tier.characters, delay: tier.delay };
}

export function nextRevealBoundary(text, start, maxCharacters) {
  let end = start;
  let characters = 0;
  while (end < text.length && characters < maxCharacters) {
    const codePoint = text.codePointAt(end);
    const value = String.fromCodePoint(codePoint);
    end += value.length;
    characters += 1;
    // Ritmik sinirlari bir sonraki frame'e tasimak noktalama beklemesini
    // dogru noktada baslatir ve kelime grubu hissini ortadan kaldirir.
    if (/[.!?…,:;\n]/u.test(value)) break;
  }
  return end;
}

export function phrasePause(text, profile = RESPONSE_MOTION_PROFILE) {
  if (/\n\s*\n\s*$/.test(text)) return profile.paragraphPause;
  if (/[.!?…]["')\]]?\s*$/.test(text)) return profile.sentencePause;
  if (/\n\s*$/.test(text)) return profile.linePause;
  if (/[,;:]\s*$/.test(text)) return profile.clausePause;
  return 0;
}

export function charactersPerSecond(pacing) {
  return pacing.delay > 0 ? pacing.characters * 1000 / pacing.delay : Infinity;
}

function defaultWait(ms, windowRef) {
  return new Promise((resolve) => {
    const timer = windowRef?.setTimeout || globalThis.setTimeout;
    timer(() => {
      if (typeof windowRef?.requestAnimationFrame === "function") {
        windowRef.requestAnimationFrame(() => resolve());
      } else {
        resolve();
      }
    }, ms);
  });
}

export function createResponseMotionController({
  element,
  onScroll = () => {},
  profile = RESPONSE_MOTION_PROFILE,
  wait = defaultWait,
} = {}) {
  if (!element) throw new Error("Response motion requires a DOM element.");
  const documentRef = element.ownerDocument;
  const windowRef = documentRef.defaultView || globalThis.window;
  const clock = windowRef?.performance || globalThis.performance;
  const startedAt = clock?.now?.() || Date.now();
  let raw = "";
  let cursor = 0;
  let complete = false;
  let stopped = false;
  let wake = null;
  let finishing = null;
  let chunks = 0;
  let peakBacklog = 0;
  let firstRevealAt = null;
  let tailValue = "";
  const settledNode = documentRef.createTextNode("");
  const tailNode = documentRef.createElement("span");
  tailNode.className = "response-flow-tail";
  tailNode.setAttribute("aria-hidden", "true");
  element.append(settledNode, tailNode);

  const appendFlow = (value) => {
    const characters = Array.from(tailValue + value);
    const overflow = Math.max(0, characters.length - profile.tailCharacters);
    if (overflow > 0) settledNode.appendData(characters.slice(0, overflow).join(""));
    tailValue = characters.slice(overflow).join("");
    tailNode.textContent = tailValue;
  };

  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  const waitForInput = () => new Promise((resolve) => { wake = resolve; });

  const pump = (async () => {
    while (!stopped) {
      if (cursor >= raw.length) {
        if (complete) break;
        await waitForInput();
        continue;
      }

      const backlog = raw.length - cursor;
      peakBacklog = Math.max(peakBacklog, backlog);
      const pacing = responsePacing(backlog, complete, peakBacklog, profile);
      const end = nextRevealBoundary(raw, cursor, pacing.characters);
      if (end === cursor) {
        await waitForInput();
        continue;
      }

      const value = raw.slice(cursor, end);
      appendFlow(value);
      cursor = end;
      chunks += 1;
      firstRevealAt ??= (clock?.now?.() || Date.now());

      onScroll();
      await wait(pacing.delay + phrasePause(value, profile), windowRef);
    }
  })();

  const metrics = () => ({
    chunks,
    peakBacklog,
    firstRevealMs: firstRevealAt == null ? null : Math.max(0, firstRevealAt - startedAt),
    presentationMs: Math.max(0, (clock?.now?.() || Date.now()) - startedAt),
  });

  return {
    append(delta) {
      if (complete || stopped) return;
      raw += String(delta || "");
      peakBacklog = Math.max(peakBacklog, raw.length - cursor);
      notify();
    },
    async finish() {
      if (!finishing) {
        finishing = (async () => {
          complete = true;
          notify();
          await pump;
          if (chunks > 0) await wait(profile.finalFlowSettle, windowRef);
          return { text: raw, metrics: metrics() };
        })();
      }
      return finishing;
    },
    interrupt() {
      stopped = true;
      notify();
      return { text: raw, metrics: metrics() };
    },
    get text() { return raw; },
    get metrics() { return metrics(); },
  };
}
