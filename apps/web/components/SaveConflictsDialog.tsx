"use client";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { useStudio, useToasts } from "@/components/context";
import { cellIdOf, textColumnOf, textValue } from "@/lib/client/model";

/*
 * 保存の競合: ドラフトを作ったあとでリソースの本文が外部で変わったセル。
 * セルごとに「自分の変更を使う」（setText で当て直して保存）か「リソースの値を使う」（そのドラフトを捨てる）を選ぶ。
 */

export interface SaveConflict {
  /** すべて保存のときはリソースごとに違う。省略時はダイアログの resourceId。 */
  resourceId?: string;
  key: string;
  language: string;
}

interface Item extends SaveConflict {
  resourceId: string;
  draft?: string;
  current?: string;
  state: "loading" | "open" | "busy" | "mine" | "theirs" | "error";
}

export function SaveConflictsDialog({
  resourceId,
  conflicts,
  onClose,
  onChanged,
  resourceNames,
}: {
  resourceId: string;
  conflicts: SaveConflict[];
  onClose(): void;
  onChanged(): void;
  resourceNames?: Map<string, string>;
}) {
  const { api, info } = useStudio();
  const { push, reportError } = useToasts();
  const [items, setItems] = useState<Item[]>(() =>
    // リソースごとにまとめて並べる
    conflicts
      .map((c) => ({ ...c, resourceId: c.resourceId ?? resourceId, state: "loading" as const }))
      .sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0)),
  );
  const textCol = textColumnOf(info);

  useEffect(() => {
    if (!textCol) return;
    let alive = true;
    const ids = [...new Set(items.map((c) => `${c.resourceId}\u0000${c.key}`))];
    Promise.all(
      ids.map((id) => {
        const [rid, key] = id.split("\u0000") as [string, string];
        return api.rowDetail({ resourceId: rid, key }).then((d) => [id, d.row] as const);
      }),
    )
      .then((pairs) => {
        if (!alive) return;
        const rows = new Map(pairs);
        setItems((list) =>
          list.map((it) => {
            const cell = rows.get(`${it.resourceId}\u0000${it.key}`)?.cells[cellIdOf(textCol, it.language)];
            return { ...it, draft: textValue(cell), current: cell?.saved ?? textValue(cell), state: "open" };
          }),
        );
      })
      .catch((err: unknown) => reportError(err, "競合したセルを読めませんでした"));
    return () => {
      alive = false;
    };
    // 開いたときに 1 回だけ読む
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, textCol, reportError]);

  const update = (i: number, patch: Partial<Item>) => setItems((list) => list.map((it, n) => (n === i ? { ...it, ...patch } : it)));

  const resolve = async (i: number, choice: "mine" | "theirs") => {
    const it = items[i];
    if (!it) return;
    update(i, { state: "busy" });
    try {
      if (choice === "mine") {
        // 同じ値でもう一度 setText すると、いまのリソースの値を基にしたドラフトになる。そのあと保存する。
        await api.setText({ resourceId: it.resourceId, key: it.key, language: it.language, value: it.draft ?? "" });
        const res = await api.save({ resourceId: it.resourceId });
        const still = res.conflicts.some((c) => c.key === it.key && c.language === it.language);
        if (still) throw new Error("もう一度競合しました。リソースがまた変更された可能性があります。");
      } else {
        // 保存済みの値と同じにすると、そのセルのドラフトだけが消える（同じ行のほかの言語は残る）
        await api.setText({ resourceId: it.resourceId, key: it.key, language: it.language, value: it.current ?? "" });
      }
      update(i, { state: choice });
      onChanged();
    } catch (err) {
      update(i, { state: "error" });
      reportError(err, `${it.key}（${it.language}）`);
    }
  };

  const remaining = items.filter((it) => it.state === "open" || it.state === "error" || it.state === "loading").length;
  const langLabel = (id: string) => info.languages.find((l) => l.id === id)?.label ?? id;

  return (
    <Dialog
      title={`保存できなかった変更（${items.length} 件）`}
      className="conflicts-dialog"
      onClose={() => {
        if (remaining === 0) push("success", "競合をすべて解決しました");
        onClose();
      }}
      footer={
        <>
          <span className="muted small footer-hint">{remaining > 0 ? `残り ${remaining} 件。閉じても未保存の変更は残ります。` : "すべて解決しました。"}</span>
          <button type="button" className="btn primary" onClick={onClose}>
            閉じる
          </button>
        </>
      }
    >
      <p className="small">ドラフトを作ったあとで、リソースのこれらの本文が外部で変更されました。セルごとにどちらを残すか選んでください。</p>
      <ul className="conflict-list">
        {items.map((it, i) => (
          <li key={`${it.resourceId}:${it.key}@${it.language}`} className={`conflict-item state-${it.state}`}>
            {(i === 0 || items[i - 1]!.resourceId !== it.resourceId) && new Set(items.map((x) => x.resourceId)).size > 1 && (
              <div className="conflict-resource mono small">{resourceNames?.get(it.resourceId) ?? it.resourceId}</div>
            )}
            <div className="conflict-head">
              <span className="mono">{it.key}</span> <span className="badge">{langLabel(it.language)}</span>
              {it.state === "mine" && <span className="badge good-badge">自分の変更を保存しました</span>}
              {it.state === "theirs" && <span className="badge">リソースの値に戻しました</span>}
            </div>
            {it.state === "loading" ? (
              <p className="muted small">読み込み中…</p>
            ) : (
              <div className="conflict-values">
                <div>
                  <div className="muted small">自分の変更（ドラフト）</div>
                  <div className="ref-text">{it.draft || <span className="muted">（空）</span>}</div>
                </div>
                <div>
                  <div className="muted small">いまのリソースの値</div>
                  <div className="ref-text">{it.current || <span className="muted">（空）</span>}</div>
                </div>
              </div>
            )}
            {(it.state === "open" || it.state === "error" || it.state === "busy") && (
              <div className="conflict-tools">
                <button type="button" className="btn small primary" disabled={it.state === "busy"} onClick={() => void resolve(i, "mine")}>
                  自分の変更を使う
                </button>
                <button type="button" className="btn small" disabled={it.state === "busy"} onClick={() => void resolve(i, "theirs")}>
                  リソースの値を使う
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
