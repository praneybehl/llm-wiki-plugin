/**
 * Test setup — polyfills jsdom-missing browser globals that some
 * UI dependencies use unconditionally.
 *
 * cmdk (used by the QuickSwitcher) calls `new ResizeObserver(...)` at
 * module init when its dialog mounts. jsdom 29 still ships no
 * ResizeObserver, so we install a minimal no-op stub. This is purely
 * a test-environment shim — production runs in a real browser.
 */

if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = ResizeObserverStub;
}

// jsdom doesn't implement Element.prototype.scrollIntoView. cmdk calls it
// when an item becomes the active selection.
if (
  typeof Element !== "undefined" &&
  typeof Element.prototype.scrollIntoView !== "function"
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).scrollIntoView = function () {};
}
