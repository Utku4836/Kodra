const ACTION_METHODS = Object.freeze({
  minimize: "minimize",
  "toggle-maximize": "toggleMaximize",
  close: "close",
});

function menuItems(menu) {
  return [...menu.querySelectorAll('[role="menuitem"]')].filter((item) => !item.disabled);
}

export function createWindowShell({
  root,
  dragRegion,
  menu,
  windowApi,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
} = {}) {
  if (!root || !menu) return { open() {}, close() {}, destroy() {} };

  let previousFocus = null;
  let open = false;
  const disposers = [];
  const listen = (target, type, handler, options) => {
    target?.addEventListener(type, handler, options);
    disposers.push(() => target?.removeEventListener(type, handler, options));
  };

  function close({ restoreFocus = false } = {}) {
    if (!open) return;
    open = false;
    menu.hidden = true;
    menu.removeAttribute("data-open");
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }

  function place(x, y) {
    const edge = 8;
    const rect = menu.getBoundingClientRect();
    const width = rect.width || 190;
    const height = rect.height || 116;
    const maxX = Math.max(edge, (windowRef?.innerWidth || width) - width - edge);
    const maxY = Math.max(edge, (windowRef?.innerHeight || height) - height - edge);
    menu.style.left = `${Math.min(Math.max(edge, x), maxX)}px`;
    menu.style.top = `${Math.min(Math.max(edge, y), maxY)}px`;
  }

  function show({ x, y, focus = true } = {}) {
    previousFocus = documentRef.activeElement;
    menu.hidden = false;
    menu.setAttribute("data-open", "true");
    open = true;
    place(Number.isFinite(x) ? x : 16, Number.isFinite(y) ? y : 16);
    if (focus) menuItems(menu)[0]?.focus({ preventScroll: true });
  }

  async function runAction(action) {
    const method = ACTION_METHODS[action];
    if (!method) return;
    close();
    try {
      const currentWindow = windowApi?.getCurrentWindow?.();
      await currentWindow?.[method]?.();
    } catch (_) {}
  }

  listen(root, "contextmenu", (event) => {
    event.preventDefault();
    show({ x: event.clientX, y: event.clientY });
  });
  listen(menu, "click", (event) => {
    const item = event.target.closest?.("[data-window-action]");
    if (item) void runAction(item.dataset.windowAction);
  });
  listen(menu, "keydown", (event) => {
    const items = menuItems(menu);
    const current = Math.max(0, items.indexOf(documentRef.activeElement));
    if (event.key === "Escape") {
      event.preventDefault();
      close({ restoreFocus: true });
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      items[(current + direction + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Tab") {
      close();
    }
  });
  listen(documentRef, "pointerdown", (event) => {
    if (open && !menu.contains(event.target)) close();
  }, true);
  listen(documentRef, "keydown", (event) => {
    if ((event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && !open) {
      event.preventDefault();
      const anchor = documentRef.activeElement?.getBoundingClientRect?.();
      show({ x: anchor?.left ?? 16, y: anchor?.bottom ?? 16 });
    }
  });
  listen(windowRef, "blur", () => close());
  listen(windowRef, "resize", () => close());
  listen(dragRegion, "pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.detail > 1) {
      event.preventDefault();
      void runAction("toggle-maximize");
      return;
    }
    try { void windowApi?.getCurrentWindow?.()?.startDragging?.(); } catch (_) {}
  });

  return {
    open: show,
    close,
    destroy() {
      close();
      disposers.splice(0).forEach((dispose) => dispose());
    },
  };
}
