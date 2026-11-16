"use client";
import { useCallback, useEffect, useState } from "react";
import type { SettingInfo, WorkspaceApi } from "@loc-studio/server";
import { Dialog } from "@/components/Dialog";
import { useStudio, useToasts } from "@/components/context";
import { canManage } from "@/lib/client/permissions";
import { ColumnsEditor, LanguagesEditor, MappingEditor, ValidatorsEditor } from "@/components/ProjectConfigEditors";
import { PluginSettingsPanel } from "@/components/PluginSettings";

/*
 * 設定。プロジェクト設定（チームで共有。loc-studio.project.json に書く）とローカル設定（この PC だけ）をタブで分ける。
 * コードの設定（loc-studio.config.ts）にある項目は読み取り専用、プロジェクト設定で固定された項目はローカル設定で変えられない。
 * 言語、列、検証、CSV / TSV の列の対応は、ここで編集できる（ProjectConfigEditors）。
 * プラグインが宣言した設定は、「プラグインの設定」のタブで編集する（PluginSettings）。
 */

type SettingsData = Awaited<ReturnType<WorkspaceApi["settings"]>>;

const SOURCE_LABEL: Record<SettingInfo["source"], string> = {
  enforce: "プロジェクト設定で固定",
  cli: "起動引数・環境変数",
  local: "この PC の設定",
  defaults: "プロジェクトの既定値",
  app: "アプリの既定値",
};

const KNOWN_LABEL: Record<string, string> = {
  "user.name": "ユーザー名",
  "ui.theme": "テーマ",
  "review.forwardOnPost": "レビュー先への転載",
};

export interface SettingsDialogProps {
  onClose(): void;
  onThemeChange(theme: string): void;
  /**
   * 保存先やプラグインフォルダなど、基盤の設定を見たり変えたりできるか。
   * Web モードではサーバーの管理者だけ（ほかの人には、サービス層がこれらの値を返さない）。省略時はできる。
   */
  infrastructure?: boolean;
}

export function SettingsDialog({ onClose, onThemeChange, infrastructure = true }: SettingsDialogProps) {
  const { api, setInfo, mode } = useStudio();
  const { reportError } = useToasts();
  const web = mode === "web";
  const [tab, setTab] = useState<"project" | "plugins" | "local">("project");
  const [data, setData] = useState<SettingsData | null>(null);

  const load = useCallback(() => {
    api
      .settings()
      .then(setData)
      .catch((err: unknown) => reportError(err, "設定の読み込み"));
  }, [api, reportError]);
  useEffect(load, [load]);

  return (
    <Dialog title="設定" className="settings-dialog" onClose={onClose}>
      <div className="tabs" role="tablist" aria-label="設定の種類">
        <button type="button" role="tab" id="tab-project" aria-selected={tab === "project"} aria-controls="panel-project" className={`tab${tab === "project" ? " on" : ""}`} onClick={() => setTab("project")}>
          プロジェクト設定
        </button>
        <button type="button" role="tab" id="tab-plugins" aria-selected={tab === "plugins"} aria-controls="panel-plugins" className={`tab${tab === "plugins" ? " on" : ""}`} onClick={() => setTab("plugins")}>
          プラグインの設定
        </button>
        <button type="button" role="tab" id="tab-local" aria-selected={tab === "local"} aria-controls="panel-local" className={`tab${tab === "local" ? " on" : ""}`} onClick={() => setTab("local")}>
          {web ? "個人設定" : "ローカル設定"}
        </button>
      </div>
      {tab === "plugins" ? (
        <div role="tabpanel" id="panel-plugins" aria-labelledby="tab-plugins">
          <PluginSettingsPanel />
        </div>
      ) : !data ? (
        <p className="muted small">読み込み中…</p>
      ) : tab === "project" ? (
        <div role="tabpanel" id="panel-project" aria-labelledby="tab-project">
          <ProjectSettings data={data} infrastructure={infrastructure} onSaved={(info) => (setInfo(info), info.restricted ? undefined : load())} />
        </div>
      ) : (
        <div role="tabpanel" id="panel-local" aria-labelledby="tab-local">
          <LocalSettings
            data={data}
            onChanged={(local, key) => {
              setData({ ...data, local });
              if (key === "ui.theme") onThemeChange(String(local.find((s) => s.key === key)?.value ?? "light"));
              if (key === "user.name") api.info().then(setInfo).catch((err: unknown) => reportError(err));
            }}
          />
        </div>
      )}
    </Dialog>
  );
}

function CodeMark() {
  const { info } = useStudio();
  const manage = canManage(info);
  if (!manage.ok) return <span className="badge" title={manage.reason}>変更不可</span>;
  return (
    <span className="badge" title="loc-studio.config.ts で決まっているので、画面からは変えられません">
      コードの設定
    </span>
  );
}

function ProjectSettings({
  data,
  onSaved,
  infrastructure,
}: {
  data: SettingsData;
  onSaved(info: Awaited<ReturnType<WorkspaceApi["info"]>>): void;
  infrastructure: boolean;
}) {
  const { api, info, mode } = useStudio();
  const { push, reportError } = useToasts();
  const p = data.project;
  const manage = canManage(info);
  // 設定で選べる登録済みの列と検証。制限された状態などで返ってこないときは、選択肢なし。
  const available = data.available ?? { columns: [], validators: [] };
  // コードの設定にある項目と、管理者でない人には変えられない
  const fromCode = (k: string) => data.projectFromCode.includes(k) || !manage.ok;
  const [name, setName] = useState(p.name ?? "");
  const [storagePath, setStoragePath] = useState(p.storage?.path ?? "");
  const [sharing, setSharing] = useState(p.storage?.sharing?.mode ?? "");
  const [pluginDirs, setPluginDirs] = useState((p.pluginDirs ?? []).join("\n"));
  const [busy, setBusy] = useState(false);

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      const next = await api.updateProjectSettings({ patch });
      // 設定ファイルがアプリの外で変わっていたときは、保存はされるが、内容を確かめるまで使わない（確認の画面に切り替わる）
      if (next.restricted) push("warning", "保存しました。設定ファイルがアプリの外でも変わっていたため、内容の確認が必要です");
      else push("success", "プロジェクト設定を保存しました");
      onSaved(next);
    } catch (err) {
      reportError(err, "プロジェクト設定を保存できませんでした");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-section">
      <p className="muted small">
        チームで共有する設定です。保存先: <span className="mono">{data.projectFile}</span>
      </p>
      {!manage.ok && <p className="hint-error">{manage.reason}</p>}
      <div className="setting-row">
        <label htmlFor="ps-name">プロジェクト名</label>
        <input id="ps-name" className="input" value={name} disabled={fromCode("name") || busy} onChange={(e) => setName(e.target.value)} />
        {fromCode("name") ? <CodeMark /> : (
          <button type="button" className="btn small" disabled={busy || name === (p.name ?? "")} onClick={() => void save({ name: name.trim() === "" ? null : name })}>
            保存
          </button>
        )}
      </div>
      <h3 className="section-title">言語{fromCode("languages") && <CodeMark />}</h3>
      <LanguagesEditor key={`languages-${JSON.stringify(p.languages)}`} languages={p.languages ?? []} locked={fromCode("languages")} busy={busy} onSave={(languages) => void save({ languages })} />
      <h3 className="section-title">列{fromCode("columns") && <CodeMark />}</h3>
      <ColumnsEditor
        key={`columns-${JSON.stringify(p.columns)}`}
        columns={p.columns}
        resolved={info.columns}
        available={available.columns}
        locked={fromCode("columns")}
        busy={busy}
        onSave={(columns) => void save({ columns })}
      />
      {infrastructure ? (
        <>
          <h3 className="section-title">共有 DB の場所{fromCode("storage") && <CodeMark />}</h3>
          <p className="small">
            いまの場所: <span className="mono">{info.storage.path}</span> {info.storage.shared ? <span className="badge warn">共有モード</span> : <span className="badge">ローカル</span>}
          </p>
          <div className="setting-row">
            <label htmlFor="ps-storage">パス（${"{env:NAME}"} が使えます）</label>
            <input id="ps-storage" className="input mono" value={storagePath} placeholder="省略時は .loc-studio/meta.db" disabled={fromCode("storage") || busy} onChange={(e) => setStoragePath(e.target.value)} />
          </div>
          <div className="setting-row">
            <label htmlFor="ps-sharing">共有の方式</label>
            <select id="ps-sharing" className="input" value={sharing} disabled={fromCode("storage") || busy} onChange={(e) => setSharing(e.target.value as typeof sharing)}>
              <option value="">共有しない（WAL）</option>
              <option value="lockfile">ネットワーク上で共有（ロックファイル）</option>
            </select>
            {!fromCode("storage") && (
              <button
                type="button"
                className="btn small"
                disabled={busy}
                onClick={() => {
                  const storage: Record<string, unknown> = { ...(p.storage ?? { driver: "sqlite" }) };
                  if (storagePath.trim()) storage["path"] = storagePath.trim();
                  else delete storage["path"];
                  if (sharing === "lockfile") storage["sharing"] = { ...(p.storage?.sharing ?? {}), mode: "lockfile" };
                  else delete storage["sharing"];
                  void save({ storage });
                }}
              >
                保存
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <h3 className="section-title">共有 DB の場所とプラグインフォルダ</h3>
          <p className="muted small">保存先、プラグインフォルダ、外部の接続先の設定は、サーバーの管理者だけが見たり変えたりできます。</p>
        </>
      )}
      <h3 className="section-title">検証{fromCode("validators") && <CodeMark />}</h3>
      <ValidatorsEditor
        key={`validators-${JSON.stringify(p.validators)}`}
        validators={p.validators}
        available={available.validators}
        locked={fromCode("validators")}
        busy={busy}
        onSave={(validators) => void save({ validators })}
      />
      {infrastructure && (
        <>
          <h3 className="section-title">CSV / TSV の列の対応{fromCode("formats") && <CodeMark />}</h3>
          <MappingEditor
            key={`formats-${JSON.stringify([p.formats, p.languages])}`}
            formats={p.formats}
            languages={p.languages ?? []}
            {...(mode === "local" && info.root ? { inspectRoot: info.root } : {})}
            locked={fromCode("formats")}
            busy={busy}
            onSave={(formats) => void save({ formats })}
          />
          <h3 className="section-title">プラグインフォルダ{fromCode("pluginDirs") && <CodeMark />}</h3>
          <div className="setting-row column">
            <label htmlFor="ps-plugindirs">プロジェクトからの相対パス（1 行に 1 つ。空なら既定の loc-studio-plugins）</label>
            <textarea id="ps-plugindirs" className="input mono" rows={3} value={pluginDirs} disabled={fromCode("pluginDirs") || busy} onChange={(e) => setPluginDirs(e.target.value)} />
            {!fromCode("pluginDirs") && (
              <button
                type="button"
                className="btn small"
                disabled={busy}
                onClick={() => {
                  const dirs = pluginDirs.split("\n").map((s) => s.trim()).filter(Boolean);
                  void save({ pluginDirs: dirs.length ? dirs : null });
                }}
              >
                保存
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function LocalSettings({ data, onChanged }: { data: SettingsData; onChanged(local: SettingInfo[], key: string): void }) {
  const { api, info, mode } = useStudio();
  const web = mode === "web";
  const { push, reportError } = useToasts();
  const set = async (key: string, value: unknown) => {
    try {
      const local = await api.setLocalSetting({ key, value });
      push("success", `${KNOWN_LABEL[key] ?? key} を変更しました`);
      onChanged(local, key);
    } catch (err) {
      reportError(err, "設定を変更できませんでした");
    }
  };
  const byKey = new Map(data.local.map((s) => [s.key, s] as const));
  const user: SettingInfo = byKey.get("user.name") ?? { key: "user.name", value: info.user.name, source: info.user.source, locked: info.user.locked };
  const theme: SettingInfo = byKey.get("ui.theme") ?? { key: "ui.theme", value: "light", source: "app", locked: false };
  const forward = byKey.get("review.forwardOnPost");
  const others = data.local.filter((s) => s.key !== "user.name" && s.key !== "ui.theme" && s.key !== "review.forwardOnPost");

  return (
    <div className="settings-section">
      {web ? (
        <p className="muted small">あなた（{info.user.name}）だけの設定です。サーバーに保存します。</p>
      ) : (
        <p className="muted small">
          この PC だけの設定です。保存先: <span className="mono">{data.localFile}</span>
        </p>
      )}
      {/* Web モードではユーザー名はログイン名で、設定では変えられない */}
      {!web && <UserNameRow setting={user} onSet={set} />}
      <div className="setting-row">
        <label htmlFor="ls-theme">テーマ</label>
        <select id="ls-theme" className="input" value={String(theme.value ?? "light")} disabled={theme.locked} onChange={(e) => void set("ui.theme", e.target.value)}>
          <option value="light">ライト</option>
          <option value="dark">ダーク</option>
          <option value="system">OS に合わせる</option>
        </select>
        <SourceMark s={theme} />
      </div>
      {forward && (
        <div className="setting-row">
          <label htmlFor="ls-forward">レビューの投稿をレビュー先へ転載</label>
          <select id="ls-forward" className="input" value={String(forward.value ?? "ask")} disabled={forward.locked} onChange={(e) => void set("review.forwardOnPost", e.target.value)}>
            <option value="always">いつも転載する</option>
            <option value="ask">投稿のたびに選ぶ</option>
            <option value="never">転載しない</option>
          </select>
          <SourceMark s={forward} />
        </div>
      )}
      {others.length > 0 && <h3 className="section-title">そのほかの設定</h3>}
      {others.map((s) => (
        <GenericRow key={s.key} setting={s} onSet={set} />
      ))}
    </div>
  );
}

function SourceMark({ s }: { s: SettingInfo }) {
  if (s.locked)
    return (
      <span className="badge warn" title="プロジェクト設定の localSettings.enforce で固定されています">
        プロジェクト設定で固定
      </span>
    );
  return <span className="muted small">{SOURCE_LABEL[s.source]}</span>;
}

function UserNameRow({ setting, onSet }: { setting: SettingInfo; onSet(key: string, v: unknown): Promise<void> }) {
  const [value, setValue] = useState(String(setting.value ?? ""));
  useEffect(() => setValue(String(setting.value ?? "")), [setting.value]);
  return (
    <div className="setting-row">
      <label htmlFor="ls-user">ユーザー名</label>
      <input id="ls-user" className="input" value={value} disabled={setting.locked} onChange={(e) => setValue(e.target.value)} />
      {!setting.locked && (
        <>
          <button type="button" className="btn small" disabled={value.trim() === "" || value === String(setting.value ?? "")} onClick={() => void onSet("user.name", value.trim())}>
            保存
          </button>
          <button type="button" className="btn small" disabled={setting.source === "app"} onClick={() => void onSet("user.name", null)} title="この PC の設定から消して、PC 名を使う">
            PC 名に戻す
          </button>
        </>
      )}
      <SourceMark s={setting} />
    </div>
  );
}

function GenericRow({ setting, onSet }: { setting: SettingInfo; onSet(key: string, v: unknown): Promise<void> }) {
  const v = setting.value;
  const kind = typeof v === "boolean" ? "boolean" : typeof v === "number" ? "number" : typeof v === "string" || v === undefined || v === null ? "string" : "json";
  const initial = kind === "json" ? JSON.stringify(v, null, 2) : v === undefined || v === null ? "" : String(v);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(initial), [initial]);
  const id = `ls-${setting.key}`;
  const commit = () => {
    let value: unknown = text;
    if (kind === "number") {
      value = Number(text);
      if (Number.isNaN(value)) return setError("数値を入力してください");
    } else if (kind === "json") {
      try {
        value = JSON.parse(text);
      } catch {
        return setError("JSON の形が正しくありません");
      }
    }
    setError(null);
    void onSet(setting.key, value);
  };
  return (
    <div className={`setting-row${kind === "json" ? " column" : ""}`}>
      <label htmlFor={id}>
        {KNOWN_LABEL[setting.key] ?? setting.key}
        {KNOWN_LABEL[setting.key] && <span className="muted small mono"> {setting.key}</span>}
      </label>
      {kind === "boolean" ? (
        <input id={id} type="checkbox" checked={v === true} disabled={setting.locked} onChange={(e) => void onSet(setting.key, e.target.checked)} />
      ) : kind === "json" ? (
        <textarea id={id} className="input mono" rows={3} value={text} disabled={setting.locked} onChange={(e) => setText(e.target.value)} />
      ) : (
        <input id={id} className="input" value={text} disabled={setting.locked} inputMode={kind === "number" ? "decimal" : undefined} onChange={(e) => setText(e.target.value)} />
      )}
      {kind !== "boolean" && !setting.locked && (
        <button type="button" className="btn small" disabled={text === initial} onClick={commit}>
          保存
        </button>
      )}
      <SourceMark s={setting} />
      {error && <span className="hint-error">{error}</span>}
    </div>
  );
}
