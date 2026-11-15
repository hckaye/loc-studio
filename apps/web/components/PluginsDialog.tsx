"use client";
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceApi } from "@loc-studio/server";
import { Dialog } from "@/components/Dialog";
import { useStudio, useToasts } from "@/components/context";
import { canManage } from "@/lib/client/permissions";
import { isRpcError } from "@/lib/client/api";

/* プラグインの一覧: 読み込んだもの（層、パス、拡張ごとの提供物）、探したフォルダ、エラーと警告、再読み込み。 */

type PluginsData = Awaited<ReturnType<WorkspaceApi["plugins"]>>;

const LAYER_LABEL: Record<string, string> = { builtin: "同梱", app: "アプリ", project: "プロジェクト", local: "この PC" };
const KIND_LABEL: Record<string, string> = {
  tree: "ツリー",
  format: "フォーマット",
  syntax: "記法",
  source: "列ソース",
  column: "列",
  generator: "生成器",
  action: "アクション",
  validator: "バリデータ",
};

export function PluginsDialog({ onClose, onUntrusted }: { onClose(): void; onUntrusted(): void }) {
  const { api, setInfo, info: current, mode } = useStudio();
  const manage = canManage(current);
  const { push, reportError } = useToasts();
  const [data, setData] = useState<PluginsData | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api
      .plugins()
      .then(setData)
      .catch((err: unknown) => reportError(err, "プラグインの一覧の読み込み"));
  }, [api, reportError]);
  useEffect(load, [load]);

  const reload = async () => {
    setBusy(true);
    try {
      const info = await api.reloadPlugins();
      setInfo(info);
      // 書き換えられたプラグインは信頼が外れるので、確認をもう一度出す
      if (info.untrustedPlugins > 0) {
        onUntrusted();
        return;
      }
      push(info.pluginErrors.length ? "warning" : "success", info.pluginErrors.length ? `再読み込みしました（エラー ${info.pluginErrors.length} 件）` : "プラグインを再読み込みしました");
      load();
    } catch (err) {
      reportError(err, "再読み込みできませんでした");
    } finally {
      setBusy(false);
    }
  };

  const untrust = async (paths: string[]) => {
    setBusy(true);
    try {
      setInfo(await api.untrustPlugins({ paths }));
      push("success", "信頼を取り消しました（このプラグインは読み込みません）");
      load();
    } catch (err) {
      reportError(err, "信頼を取り消せませんでした");
    } finally {
      setBusy(false);
    }
  };
  /** 一覧に出した path と hash をそのまま返す。そのあいだに変わっていたら（conflict）読み直して確かめ直してもらう。 */
  const trust = async (item: { path: string; hash: string }) => {
    setBusy(true);
    try {
      setInfo(await api.trustPlugins({ items: [item] }));
      push("success", "信頼して読み込みました");
      load();
    } catch (err) {
      if (isRpcError(err, "conflict")) {
        push("warning", "確認しているあいだにファイルが変わりました。一覧を読み直したので、内容をもう一度確かめてください。");
        load();
      } else reportError(err, "信頼できませんでした");
    } finally {
      setBusy(false);
    }
  };
  // 信頼の確認はローカルモードだけ（Web モードのプラグインは管理者が置いたもの）
  const trustable = (layer: string) => mode !== "web" && (layer === "project" || layer === "local");

  return (
    <Dialog
      title="プラグイン"
      className="plugins-dialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            閉じる
          </button>
          <button type="button" className="btn primary" disabled={busy || !manage.ok} title={manage.reason} onClick={() => void reload()}>
            {busy ? "再読み込み中…" : "プラグインを再読み込み"}
          </button>
        </>
      }
    >
      {!data ? (
        <p className="muted small">読み込み中…</p>
      ) : (
        <>
          {(data.errors.length > 0 || data.warnings.length > 0) && (
            <section>
              <h3 className="section-title">エラーと警告</h3>
              <ul className="plain-list">
                {data.errors.map((e, i) => (
                  <li key={`e${i}`} className="issue sev-error">
                    <span className="sev-badge sev-error">エラー</span> <span className="badge">{LAYER_LABEL[e.layer] ?? e.layer}</span> <span className="mono small">{e.path}</span>
                    <div>{e.message}</div>
                  </li>
                ))}
                {data.warnings.map((w, i) => (
                  <li key={`w${i}`} className="issue sev-warning">
                    <span className="sev-badge sev-warning">警告</span> {w}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {mode !== "web" && data.untrusted.length > 0 && (
            <section>
              <h3 className="section-title">信頼していないため読み込んでいないプラグイン（{data.untrusted.length}）</h3>
              <ul className="plain-list">
                {data.untrusted.map((u) => (
                  <li key={u.path} className="trust-row">
                    <span className="badge warn">未信頼</span> <span className="badge">{u.kind === "config" ? "コードの設定" : "プラグイン"}</span>{" "}
                    <span className="badge">{LAYER_LABEL[u.layer] ?? u.layer}</span> <span className="mono small break">{u.path}</span>
                    <span className="muted small">（{u.files.length} ファイル）</span>
                    <button type="button" className="btn small" disabled={busy} onClick={() => void trust({ path: u.path, hash: u.hash })}>
                      信頼する
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3 className="section-title">読み込んだプラグイン（{data.plugins.length}）</h3>
            <table className="table small">
              <thead>
                <tr>
                  <th>名前</th>
                  <th>層</th>
                  <th>提供するもの</th>
                </tr>
              </thead>
              <tbody>
                {data.plugins.map((p) => (
                  <tr key={`${p.layer}:${p.name}:${p.path ?? ""}`}>
                    <td>
                      <div>
                        {p.name} {p.version && <span className="muted">v{p.version}</span>}
                      </div>
                      {p.path && <div className="mono muted small break">{p.path}</div>}
                    </td>
                    <td>
                      <span className="badge">{LAYER_LABEL[p.layer] ?? p.layer}</span>
                      {trustable(p.layer) && p.path && (
                        <div className="trust-cell">
                          <span className="badge good-badge">信頼済み</span>
                          <button type="button" className="btn small" disabled={busy} onClick={() => void untrust([p.path!])}>
                            信頼を取り消す
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      {Object.entries(p.provides)
                        .filter(([, ids]) => ids.length > 0)
                        .map(([kind, ids]) => (
                          <div key={kind} className="small">
                            <span className="muted">{KIND_LABEL[kind] ?? kind}:</span> <span className="mono">{ids.join(", ")}</span>
                          </div>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <h3 className="section-title">探したフォルダ（後ろほど優先）</h3>
            <ul className="plain-list small">
              {data.dirs.map((d) => (
                <li key={`${d.layer}:${d.dir}`}>
                  <span className="badge">{LAYER_LABEL[d.layer] ?? d.layer}</span> <span className="mono break">{d.dir}</span>{" "}
                  {d.exists ? <span className="good">あり</span> : <span className="muted">なし</span>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </Dialog>
  );
}
