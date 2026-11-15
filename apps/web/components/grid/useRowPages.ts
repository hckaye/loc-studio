"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CellInfo, RowInfo, RowsRequest, RowsResponse } from "@loc-studio/server";
import type { ClientApi } from "@/lib/client/api";

/*
 * 表の行をページ単位で読み込む。見えている範囲のページだけを取りに行き、読んだページは覚えておく。
 * 条件（絞り込み、検索、言語）が変わったら全部捨てる。保存や他の人の変更のあとは、見えているページを読み直す
 * （読み直している間は古い行を出したままにして、ちらつかせない）。
 */

export type RowQuery = Omit<RowsRequest, "offset" | "limit">;

export const PAGE_SIZE = 100;

interface PageState {
  sig: string;
  gen: number;
  pages: Map<number, RowInfo[]>;
  inflight: Map<number, Promise<void>>;
  range: { start: number; end: number };
}

export interface RowPages {
  total: number;
  totalAll: number;
  diagnostics: RowsResponse["diagnostics"];
  loaded: boolean;
  loading: boolean;
  version: number;
  getRow(index: number): RowInfo | undefined;
  ensureRange(start: number, end: number): void;
  loadRow(index: number): Promise<RowInfo | undefined>;
  patchRow(key: string, cells: Record<string, CellInfo>): void;
  refresh(): void;
  /** 読み込み済みの行（一括操作で使う）。 */
  findIndex(key: string): number;
}

export function useRowPages(api: ClientApi, query: RowQuery | null, onError: (err: unknown) => void): RowPages {
  const sig = useMemo(() => (query ? JSON.stringify(query) : ""), [query]);
  const stateRef = useRef<PageState>({ sig: "", gen: 0, pages: new Map(), inflight: new Map(), range: { start: 0, end: 0 } });
  const [meta, setMeta] = useState<{ total: number; totalAll: number; diagnostics: RowsResponse["diagnostics"]; loaded: boolean }>({
    total: 0,
    totalAll: 0,
    diagnostics: [],
    loaded: false,
  });
  const [version, setVersion] = useState(0);
  const [loadingCount, setLoadingCount] = useState(0);
  const queryRef = useRef(query);
  queryRef.current = query;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const fetchPage = useCallback(
    (page: number, force = false): Promise<void> => {
      const st = stateRef.current;
      const q = queryRef.current;
      if (!q) return Promise.resolve();
      if (!force && st.pages.has(page)) return Promise.resolve();
      const key = page;
      const existing = st.inflight.get(key);
      if (existing && !force) return existing;
      const gen = st.gen;
      setLoadingCount((n) => n + 1);
      const p = api
        .rows({ ...q, offset: page * PAGE_SIZE, limit: PAGE_SIZE })
        .then((res) => {
          if (stateRef.current.gen !== gen) return;
          stateRef.current.pages.set(page, res.rows);
          setMeta({ total: res.total, totalAll: res.totalAll, diagnostics: res.diagnostics, loaded: true });
          setVersion((v) => v + 1);
        })
        .catch((err: unknown) => {
          if (stateRef.current.gen === gen) onErrorRef.current(err);
        })
        .finally(() => {
          if (stateRef.current.inflight.get(key) === p) stateRef.current.inflight.delete(key);
          setLoadingCount((n) => n - 1);
        });
      st.inflight.set(key, p);
      return p;
    },
    [api],
  );

  // 条件が変わったら捨てて最初のページから
  useEffect(() => {
    const st = stateRef.current;
    st.sig = sig;
    st.gen++;
    st.pages = new Map();
    st.inflight = new Map();
    setMeta((m) => ({ ...m, loaded: false }));
    setVersion((v) => v + 1);
    if (sig) {
      const first = Math.floor(st.range.start / PAGE_SIZE);
      const last = Math.floor(Math.max(st.range.start, st.range.end) / PAGE_SIZE);
      for (let p = Math.max(0, first); p <= last; p++) void fetchPage(p);
      if (last < 0 || first > last) void fetchPage(0);
    }
  }, [sig, fetchPage]);

  const ensureRange = useCallback(
    (start: number, end: number) => {
      const st = stateRef.current;
      st.range = { start, end };
      if (!queryRef.current) return;
      const first = Math.max(0, Math.floor(start / PAGE_SIZE));
      const last = Math.max(first, Math.floor(end / PAGE_SIZE));
      for (let p = first; p <= last; p++) void fetchPage(p);
    },
    [fetchPage],
  );

  const getRow = useCallback((index: number) => stateRef.current.pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE], []);

  const loadRow = useCallback(
    async (index: number) => {
      const page = Math.floor(index / PAGE_SIZE);
      await fetchPage(page);
      return stateRef.current.pages.get(page)?.[index % PAGE_SIZE];
    },
    [fetchPage],
  );

  const patchRow = useCallback((key: string, cells: Record<string, CellInfo>) => {
    let changed = false;
    for (const rows of stateRef.current.pages.values()) {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        if (r.key === key) {
          rows[i] = { ...r, cells: { ...r.cells, ...cells } };
          changed = true;
        }
      }
    }
    if (changed) setVersion((v) => v + 1);
  }, []);

  const refresh = useCallback(() => {
    const st = stateRef.current;
    if (!queryRef.current) return;
    // 見えているページだけ読み直し、ほかは捨てる（次に見えたときに読む）
    const first = Math.max(0, Math.floor(st.range.start / PAGE_SIZE));
    const last = Math.max(first, Math.floor(st.range.end / PAGE_SIZE));
    for (const p of [...st.pages.keys()]) if (p < first || p > last) st.pages.delete(p);
    st.inflight.clear();
    for (let p = first; p <= last; p++) void fetchPage(p, true);
  }, [fetchPage]);

  const findIndex = useCallback((key: string) => {
    for (const [page, rows] of stateRef.current.pages) {
      const i = rows.findIndex((r) => r.key === key);
      if (i >= 0) return page * PAGE_SIZE + i;
    }
    return -1;
  }, []);

  return { ...meta, loading: loadingCount > 0, version, getRow, ensureRange, loadRow, patchRow, refresh, findIndex };
}
