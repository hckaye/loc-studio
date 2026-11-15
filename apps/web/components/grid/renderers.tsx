"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/*
 * プラグインの独自描画（CellRenderer）。ブラウザ用の ES モジュールを実行時に読み込み、セルの要素に描かせる。
 * - モジュールはハッシュごとに 1 回だけ読む（URL に h を付け、サーバーは長くキャッシュさせる）。
 * - import はバンドラーに書き換えさせない（ビルドに含めず、プラグインを置くだけで動くように）。
 * - 読み込みや描画の失敗はそのセルの中に閉じ込める（値と失敗の印を出し、表やほかのセルは壊さない）。
 * - 仮想化でセルはしょっちゅう作り直されるので、描画のたびと消えるときに後片付けの関数を必ず呼ぶ。
 */

export interface RenderContext {
  value: unknown;
  error?: string;
  column: { id: string; label?: string; type?: unknown; options?: Record<string, unknown> };
  language?: { id: string; label: string };
  entryKey: string;
  resourceId: string;
  theme: "light" | "dark";
  readOnly: boolean;
  setValue?(value: unknown): Promise<void>;
}

export interface RendererModule {
  render(element: HTMLElement, ctx: RenderContext): void | (() => void);
}

export type RendererLoader = (id: string, hash: string) => Promise<RendererModule>;

const cache = new Map<string, Promise<RendererModule>>();

/** 既定の読み込み: /api/renderer/<id>?project=…&h=<hash> を動的 import する。 */
export function defaultRendererLoader(project: string): RendererLoader {
  return (id, hash) => {
    const url = `/api/renderer/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}&h=${encodeURIComponent(hash)}`;
    let p = cache.get(url);
    if (!p) {
      p = (import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ url) as Promise<{ default?: unknown }>).then((m) => {
        const mod = m.default as RendererModule | undefined;
        if (!mod || typeof mod.render !== "function") throw new Error(`独自描画 "${id}" のモジュールに render がありません（default export を確かめてください）`);
        return mod;
      });
      cache.set(url, p);
      // 失敗したら次に描くときにやり直せるようにする
      p.catch(() => cache.delete(url));
    }
    return p;
  };
}

interface RendererEnv {
  loader: RendererLoader;
  /** id → ハッシュ（info.renderers）。 */
  hashes: Map<string, string>;
}

const RendererContext = createContext<RendererEnv | null>(null);

export function RendererProvider({ loader, renderers, children }: { loader: RendererLoader; renderers: { id: string; hash: string }[]; children: ReactNode }) {
  const hashes = new Map(renderers.map((r) => [r.id, r.hash] as const));
  return <RendererContext.Provider value={{ loader, hashes }}>{children}</RendererContext.Provider>;
}

export function useRendererEnv(): RendererEnv | null {
  return useContext(RendererContext);
}

function currentTheme(): "light" | "dark" {
  return typeof document !== "undefined" && document.documentElement.dataset["theme"] === "dark" ? "dark" : "light";
}

function stableKey(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "undefined";
  } catch {
    return String(v);
  }
}

/** 独自描画のセル。失敗したら fallback（ふつうの値の表示）と失敗の印を出す。 */
export function RenderedCell({ rendererId, ctx, fallback }: { rendererId: string; ctx: Omit<RenderContext, "theme">; fallback: ReactNode }) {
  const env = useRendererEnv();
  const ref = useRef<HTMLSpanElement>(null);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const [failure, setFailure] = useState<string | null>(null);
  const hash = env?.hashes.get(rendererId);
  const key = `${stableKey(ctx.value)}|${ctx.error ?? ""}|${ctx.readOnly}|${ctx.entryKey}|${ctx.language?.id ?? ""}`;

  const runCleanup = () => {
    const c = cleanupRef.current;
    cleanupRef.current = undefined;
    if (c) {
      try {
        c();
      } catch (err) {
        console.error(`独自描画 "${rendererId}" の後片付けで失敗しました`, err);
      }
    }
  };

  useEffect(() => {
    if (!env || hash === undefined) {
      setFailure(`独自描画 "${rendererId}" は登録されていません`);
      return;
    }
    let alive = true;
    setFailure(null);
    env
      .loader(rendererId, hash)
      .then((mod) => {
        if (!alive || !ref.current) return;
        runCleanup();
        const el = ref.current;
        el.replaceChildren();
        try {
          const c = mod.render(el, { ...ctxRef.current, theme: currentTheme() });
          if (typeof c === "function") cleanupRef.current = c;
        } catch (err) {
          el.replaceChildren();
          setFailure(`描画に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
      .catch((err: unknown) => {
        if (alive) setFailure(`読み込めませんでした: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, hash, rendererId, key]);

  // セルが消えるときの後片付け
  useEffect(() => () => runCleanup(), []); // eslint-disable-line react-hooks/exhaustive-deps

  if (failure) {
    return (
      <>
        {fallback}
        <span className="marks">
          <span className="mark mark-error" title={failure} aria-label={`独自描画の失敗: ${failure}`}>
            !
          </span>
        </span>
      </>
    );
  }
  return <span ref={ref} className="rendered-cell" data-renderer={rendererId} />;
}
