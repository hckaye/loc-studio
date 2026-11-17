"use client";
import { useCallback, useEffect, useState } from "react";
import type { PluginSettingsInfo } from "@loc-studio/server";
import { useStudio, useToasts } from "@/components/context";
import { canManage } from "@/lib/client/permissions";

/*
 * 設定の画面の「プラグインの設定」。設定（settings）を宣言しているプラグインごとに、宣言した項目の入力欄を出す。
 * 欄は、プラグインの宣言から作る（プラグインの名前や項目を、画面のコードに決め打ちしない）。
 * 保存すると、プロジェクトの loc-studio-plugin-settings/<プラグインの名前>.json に書かれ、プラグインは次から新しい値で動く。
 * 正しさを決めるのはサーバー（宣言にないキーや、種類の合わない値は、サーバーが何も書かずに断る）。
 */

type Item = PluginSettingsInfo["items"][number];
type Value = string | number | boolean;

const LAYER_LABEL: Record<PluginSettingsInfo["layer"], string> = { builtin: "同梱", app: "アプリ", project: "プロジェクト", local: "個人" };

/** 入力欄の文字（数値は文字として持ち、保存するときに数にする）。値のない項目は空。 */
const toDraft = (item: Item, value: Value | undefined): string | boolean => (item.type === "boolean" ? value === true : value === undefined ? "" : String(value));

/** 入力欄の文字を、保存する値にする。空は「値なし」（null。既定の値に戻す）。数値でない文字は、理由。 */
function fromDraft(item: Item, draft: string | boolean): { value: Value | null } | { error: string } {
  if (item.type === "boolean") return { value: draft === true };
  const text = String(draft);
  if (item.type === "number") {
    if (text.trim() === "") return { value: null };
    const n = Number(text);
    return Number.isFinite(n) ? { value: n } : { error: `「${item.label}」は、数値で入力してください。` };
  }
  // 文字と選択式: 空は値なし。
  return { value: text === "" ? null : text };
}

function PluginForm({ plugin, locked, lockedReason, onSaved }: { plugin: PluginSettingsInfo; locked: boolean; lockedReason: string | undefined; onSaved(next: PluginSettingsInfo[]): void }) {
  const { api } = useStudio();
  const { push, reportError } = useToasts();
  // いま保存されている値（設定ファイルにあるものだけ。既定の値で動いている項目は、空の欄にして既定の値を添える）。
  const savedDraft = (item: Item) => toDraft(item, item.stored ? item.value : item.type === "boolean" ? item.value : undefined);
  const [drafts, setDrafts] = useState<Record<string, string | boolean>>(() => Object.fromEntries(plugin.items.map((i) => [i.key, savedDraft(i)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = plugin.items.filter((i) => drafts[i.key] !== savedDraft(i));
  const id = (key: string) => `plugin-setting-${plugin.plugin}-${key}`;

  const save = async () => {
    const values: Record<string, Value | null> = {};
    for (const item of changed) {
      const parsed = fromDraft(item, drafts[item.key] ?? "");
      if ("error" in parsed) return setError(parsed.error);
      values[item.key] = parsed.value;
    }
    setError(null);
    setBusy(true);
    try {
      const next = await api.setPluginSettings({ plugin: plugin.plugin, values });
      push("success", `プラグイン「${plugin.plugin}」の設定を保存しました`);
      onSaved(next);
    } catch (err) {
      reportError(err, `プラグイン「${plugin.plugin}」の設定を保存できませんでした`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="plugin-settings" aria-label={`プラグイン ${plugin.plugin} の設定`}>
      <h3 className="section-title">
        {plugin.plugin}
        {plugin.version && <span className="muted small"> v{plugin.version}</span>} <span className="badge">{LAYER_LABEL[plugin.layer]}</span>
      </h3>
      {plugin.file !== "" && (
        <p className="muted small">
          設定ファイル: <span className="mono">{plugin.file}</span>
        </p>
      )}
      {plugin.problems.map((p, i) => (
        <p key={i} className="hint-error" role="alert">
          {p}
        </p>
      ))}
      {plugin.items.map((item) => {
        const draft = drafts[item.key] ?? "";
        const set = (v: string | boolean) => {
          setError(null);
          setDrafts((d) => ({ ...d, [item.key]: v }));
        };
        const defaultNote = item.default !== undefined ? `既定の値: ${item.type === "enum" ? (item.options?.find((o) => o.value === item.default)?.label ?? String(item.default)) : String(item.default)}` : "既定の値なし";
        return (
          <div key={item.key} className="plugin-setting">
            {item.type === "boolean" ? (
              <label className="check" title={lockedReason}>
                <input id={id(item.key)} type="checkbox" checked={draft === true} disabled={locked || busy} onChange={(e) => set(e.target.checked)} />
                <span>{item.label}</span>
              </label>
            ) : (
              <>
                <label htmlFor={id(item.key)} className="field-label">
                  {item.label}
                </label>
                {item.type === "enum" ? (
                  <select id={id(item.key)} className="input" value={String(draft)} disabled={locked || busy} title={lockedReason} onChange={(e) => set(e.target.value)}>
                    <option value="">（既定の値を使う）</option>
                    {(item.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label ?? o.value}
                      </option>
                    ))}
                  </select>
                ) : item.multiline ? (
                  <>
                    <textarea
                      id={id(item.key)}
                      className="input"
                      rows={6}
                      value={String(draft)}
                      placeholder={item.default !== undefined ? String(item.default) : ""}
                      disabled={locked || busy}
                      title={lockedReason}
                      onChange={(e) => set(e.target.value)}
                    />
                    {item.default !== undefined && (
                      <div className="row">
                        <button type="button" className="btn small" disabled={locked || busy || draft === String(item.default)} title={lockedReason ?? "既定の文章を入力欄に入れます。そこから書き換えられます。"} onClick={() => set(String(item.default))}>
                          既定の文章を入力欄に入れる
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <input
                    id={id(item.key)}
                    className="input"
                    type="text"
                    inputMode={item.type === "number" ? "decimal" : undefined}
                    value={String(draft)}
                    placeholder={item.default !== undefined ? String(item.default) : ""}
                    disabled={locked || busy}
                    title={lockedReason}
                    onChange={(e) => set(e.target.value)}
                  />
                )}
              </>
            )}
            <p className="muted small">
              {item.description && <>{item.description} </>}
              {/* 複数行の項目は、既定の値が長いので、たたんで出す。 */}
              <span>
                {item.multiline && item.default !== undefined ? "既定の値は、下で見られます" : defaultNote}
                {item.type !== "boolean" && !item.stored && "（いまは既定の値で動いています）"}
              </span>
            </p>
            {item.multiline && item.default !== undefined && (
              <details className="muted small">
                <summary>既定の値を見る</summary>
                <pre>{String(item.default)}</pre>
              </details>
            )}
          </div>
        );
      })}
      {error !== null && (
        <p className="hint-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="button" className="btn small primary" disabled={locked || busy || changed.length === 0} title={lockedReason} onClick={() => void save()}>
          {busy ? "保存しています…" : "設定を保存"}
        </button>
        {changed.length > 0 && !busy && (
          <button type="button" className="btn small" onClick={() => (setError(null), setDrafts(Object.fromEntries(plugin.items.map((i) => [i.key, savedDraft(i)]))))}>
            変更を戻す
          </button>
        )}
      </div>
    </section>
  );
}

export function PluginSettingsPanel() {
  const { api, info } = useStudio();
  const { reportError } = useToasts();
  const [plugins, setPlugins] = useState<PluginSettingsInfo[] | null>(null);
  const manage = canManage(info);

  const load = useCallback(() => {
    api
      .pluginSettings()
      .then(setPlugins)
      .catch((err: unknown) => reportError(err, "プラグインの設定の読み込み"));
  }, [api, reportError]);
  useEffect(load, [load]);

  if (plugins === null) return <p className="muted small">読み込み中…</p>;
  if (plugins.length === 0) {
    return (
      <p className="muted small">
        設定を宣言しているプラグインはありません。プラグインが <span className="mono">settings</span> で項目を宣言すると、ここに入力欄が出ます。
      </p>
    );
  }
  return (
    <div className="plugin-settings-list">
      <p className="muted small">
        プラグインが宣言した設定です。保存すると、プロジェクトのフォルダの <span className="mono">loc-studio-plugin-settings/</span> に、プラグインごとのファイルとして書かれ、チームで共有できます。
        {!manage.ok && ` ${manage.reason}。`}
      </p>
      {plugins.map((p) => (
        // 保存のあとは、保存された値から入力欄を作り直す。
        <PluginForm key={`${p.plugin}:${JSON.stringify(p.items.map((i) => [i.key, i.stored, i.value]))}`} plugin={p} locked={!manage.ok} lockedReason={manage.reason} onSaved={setPlugins} />
      ))}
    </div>
  );
}
