import { afterEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";

// ルートの npm test は node のテストと並べて動くので、待ち時間に余裕を持たせる
configure({ asyncUtilTimeout: 5000 });

// jsdom には配置の計算がないので、表の仮想化に必要な大きさを与える
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const origRect = HTMLElement.prototype.getBoundingClientRect;
HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.classList.contains("grid-scroll")) {
    return { x: 0, y: 0, top: 0, left: 0, right: 1600, bottom: 800, width: 1600, height: 800, toJSON() {} } as DOMRect;
  }
  return origRect.call(this);
};
for (const [prop, size] of [["clientWidth", 1600], ["clientHeight", 800]] as const) {
  const orig = Object.getOwnPropertyDescriptor(Element.prototype, prop);
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains("grid-scroll")) return size;
      return orig?.get ? orig.get.call(this) : 0;
    },
  });
}
Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get() {
    return this.parentNode;
  },
});
Element.prototype.scrollTo = function (this: Element, opts?: ScrollToOptions | number) {
  if (typeof opts === "object") {
    if (opts.top !== undefined) (this as HTMLElement).scrollTop = opts.top;
    if (opts.left !== undefined) (this as HTMLElement).scrollLeft = opts.left;
  }
} as Element["scrollTo"];
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    // 使えない環境では何もしない
  }
});
