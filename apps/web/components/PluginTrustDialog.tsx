"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectInfo, SummaryRow, UntrustedPluginInfo } from "@loc-studio/server";
import { Dialog } from "@/components/Dialog";
import { useStudioOptional, useToasts } from "@/components/context";
import { isRpcError, type ClientApi } from "@/lib/client/api";

/*
 * 信頼の確認（ローカルモード）。対象は 3 種類。
 * - settings: プロジェクトの設定ファイル（保存先、プラグインのフォルダ、外部の接続先、使う環境変数を決める）
 * - config:   プロジェクトのコードの設定（loc-studio.config.*）
 * - plugin:   プロジェクトのフォルダとこの PC のプラグインフォルダのコード
 * 利用者が中身（ハッシュ）を確かめて信頼するまで、設定は使わず、コードは実行しない。
 * 信頼するときは、画面に出した path と hash をそのまま返す。そのあいだにファイルが変わっていたら（conflict）、
 * 一覧を読み直してもう一度確かめてもらう。
 * 設定ファイルを信頼するとプロジェクトを開き直すので、続けてコード（プラグインのフォルダは設定で決まる）の確認が出ることがある。
 */

const LAYER_LABEL: Record<string, string> = { builtin: "同梱", app: "アプリ", project: "プロジェクト", local: "この PC" };
const KIND_LABEL: Record<string, string> = { settings: "設定ファイル", config: "コードの設定", plugin: "プラグイン" };
const FILES_COLLAPSE = 6;

export interface PluginTrustDialogProps {
  onTrusted(info: ProjectInfo): void;
  onSkip(): void;
  /** 制限された状態（設定ファイルやコードの設定を信頼するまで開けない）。閉じるとプロジェクトを閉じる。 */
  restricted?: boolean;
  /** 設定ファイルを信頼した直後の、続きの確認（コード）として出すとき。 */
  continued?: boolean;
  /** 作業の途中で、ファイルがアプリの外で変わって確認が必要になったとき（表の画面は後ろに残してある）。 */
  midSession?: boolean;
  /** StudioProvider の外（制限された状態の画面）で使うとき。 */
  api?: ClientApi;
  projectName?: string;
}

export function PluginTrustDialog(props: PluginTrustDialogProps) {
  const studio = useStudioOptional();
  const api = props.api ?? studio!.api;
  const name = props.projectName ?? studio?.info.name ?? "";
  const { push, reportError } = useToasts();
  const [list, setList] = useState<UntrustedPluginInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const [continued, setContinued] = useState(props.continued === true);

  const restrictedRef = useRef(props.restricted === true);
  restrictedRef.current = props.restricted === true;
  const onTrustedLatest = useRef(props.onTrusted);
  onTrustedLatest.current = props.onTrusted;
  const load = useCallback(() => {
    setList(null);
    api
      .plugins()
      .then(async (p) => {
        setList(p.untrusted);
        // 制限された状態なのに確認するものがない（ファイルが信頼済みの中身に戻った、など）: 読み直して先へ進む
        if (restrictedRef.current && p.untrusted.length === 0) onTrustedLatest.current(await api.reloadPlugins());
      })
      .catch((err: unknown) => reportError(err, "プラグインの一覧を読めませんでした"));
  }, [api, reportError]);
  useEffect(load, [load]);

  const trust = async () => {
    if (!list || list.length === 0) return;
    setBusy(true);
    try {
      // 画面に出したものと同じ path と hash を返す（そのあいだに書き換えられていたら conflict）
      const next = await api.trustPlugins({ items: list.map((p) => ({ path: p.path, hash: p.hash })) });
      if (next.pluginErrors.length > 0) push("warning", `読み込みました（エラー ${next.pluginErrors.length} 件。プラグインの画面で確認できます）`);
      else push("success", `${list.length} 件を信頼して読み込みました`);
      setChanged(false);
      if (next.restricted) {
        // 設定ファイルを信頼して開き直したら、続けてコードの設定の確認が要る
        setContinued(true);
        load();
      }
      onTrustedRef(next);
    } catch (err) {
      if (isRpcError(err, "conflict")) {
        // 見せたあとで中身が変わった。サービス層に読み直させてから一覧を取り直す（制限された状態の一覧は、開いたときのもの）。
        // 読み直した結果、確認するものがなくなっていれば（信頼済みの中身に戻った）そのまま先へ進む。
        try {
          const next = await api.reloadPlugins();
          if (restrictedRef.current && !next.restricted) {
            onTrustedRef(next);
            return;
          }
        } catch (reloadErr) {
          if (!isRpcError(reloadErr, "untrusted")) reportError(reloadErr, "読み直せませんでした");
        }
        setChanged(true);
        load();
      } else reportError(err, "読み込めませんでした");
    } finally {
      setBusy(false);
    }
  };
  const onTrustedRef = props.onTrusted;

  const hasSettings = list?.some((p) => p.kind === "settings") ?? false;
  const hasConfig = list?.some((p) => p.kind === "config") ?? false;
  const codeCount = list?.filter((p) => p.kind !== "settings").length ?? 0;
  const title = hasSettings
    ? codeCount > 0
      ? "このプロジェクトの設定とコードを信頼しますか"
      : "このプロジェクトの設定を信頼しますか"
    : hasConfig
      ? "このプロジェクトのコードを実行しますか"
      : "このプロジェクトのプラグインを実行しますか";

  return (
    <Dialog
      title={title}
      className="trust-dialog"
      onClose={props.onSkip}
      initialFocus=".trust-skip"
      footer={
        <>
          <button type="button" className="btn trust-skip" onClick={props.onSkip} disabled={busy}>
            {props.restricted ? "プロジェクトを閉じる" : "読み込まずに開く"}
          </button>
          <button type="button" className="btn primary" onClick={() => void trust()} disabled={busy || !list || list.length === 0}>
            {hasSettings && codeCount === 0 ? "信頼して開く" : "信頼して読み込む"}
          </button>
        </>
      }
    >
      {changed && (
        <p className="hint-error" role="alert">
          確認しているあいだにファイルが変わりました。一覧を読み直したので、内容をもう一度確かめてください。
        </p>
      )}
      {props.midSession && (
        <p className="trust-continued small" role="status">
          プロジェクトの設定かコードの設定が、アプリの外で変わりました。内容を確認して信頼すると、元の画面に戻ります。保存していない変更と、編集中の入力は残っています。
        </p>
      )}
      {continued && !props.midSession && list !== null && list.length > 0 && (
        <p className="trust-continued small" role="status">
          設定を信頼しました。続けて、このプロジェクトのコードを確認します。
        </p>
      )}
      <div className="trust-warning" role="note">
        {hasSettings && (
          <>
            <p>
              「{name}」の<strong>設定ファイル</strong>を確認してください。設定ファイルは、データの保存先、読み込むプラグインのフォルダ、接続する外部のサービス、使う環境変数を決めます。
            </p>
            <p>
              書かれた接続先には、この PC からあなたの権限で接続します。下の内容に心当たりがある、信頼できる人のプロジェクトだけ開いてください。
            </p>
          </>
        )}
        {codeCount > 0 && (
          <>
            <p>
              「{name}」には、実行されるコードが <strong>{codeCount} 件</strong>あります。
            </p>
            <p>
              コードは、この PC の上で<strong>あなたと同じ権限</strong>で動き、ファイルの読み書きやネットワークへの接続ができます。
              内容を知っている、信頼できる人のプロジェクトだけ読み込んでください。
            </p>
          </>
        )}
        {list !== null && list.length === 0 && <p>確認が必要なものはありません。</p>}
        {props.restricted ? (
          <p className="small">
            {hasSettings ? (
              <>
                プロジェクトは設定がないと動かないため、<strong>設定ファイルを信頼するまで開けません</strong>（読み込まずに開くことはできません）。信頼しない場合はプロジェクトを閉じます。
                保存先などの項目が変わると、もう一度確認します。言語や列などの変更では確認しません。
              </>
            ) : (
              <>
                このプロジェクトは<strong>コードの設定（loc-studio.config.*）</strong>を使っているため、信頼するまで開けません。信頼しない場合はプロジェクトを閉じます。
              </>
            )}
          </p>
        ) : (
          <p className="muted small">
            読み込まずに開いても、本文の編集と保存はできます。プラグインが提供するバリデータ、列、アクションなどは使えません。ファイルが変わると、もう一度確認します。
          </p>
        )}
      </div>
      {list === null ? (
        <p className="muted small">読み込み中…</p>
      ) : (
        <ul className="trust-list">
          {list.map((p) => (
            <li key={`${p.kind}:${p.path}`} className="trust-item">
              <div className="trust-head">
                <span className={`badge${p.kind !== "plugin" ? " warn" : ""}`}>{KIND_LABEL[p.kind] ?? p.kind}</span>
                <span className="badge">{LAYER_LABEL[p.layer] ?? p.layer}</span>
                <span className="mono break">{p.path}</span>
              </div>
              {p.kind === "config" && <p className="small trust-config-note">プロジェクトのコードの設定（loc-studio.config.*）です。開くたびにこのファイルのコードが実行されます。</p>}
              {p.kind === "settings" && (
                <>
                  <p className="small trust-config-note">プロジェクトの設定ファイルです。次の内容で開きます（値は書かれたままの形で、パスワードは伏せてあります）。</p>
                  <SummaryList summary={p.summary ?? []} />
                </>
              )}
              <FileList files={p.files} hash={p.hash} />
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/**
 * 設定ファイルの要約。接続先やパスを見落とさないよう、値は省略せずに折り返して出す。
 * 値は <bdi> で囲み、文字の向きを変える制御文字で前後の表示が入れ替わらないようにする。
 * host は、値を URL として解析した実際の接続先（"https://good@evil" のような紛らわしい書き方でも、ここを見れば分かる）。
 */
function SummaryList({ summary }: { summary: SummaryRow[] }) {
  if (summary.length === 0) return <p className="muted small">要約できる項目はありません。</p>;
  // 接続先は一覧の中に埋もれないよう、先頭にもまとめて出す
  const hosts = [...new Set(summary.map((r) => r.host).filter((h): h is string => h !== undefined))];
  return (
    <>
      {hosts.length > 0 && (
        <p className="trust-hosts small" role="note">
          この設定で接続する先:{" "}
          {hosts.map((h) => (
            <span key={h} className="badge warn mono">
              <bdi>{h}</bdi>
            </span>
          ))}
        </p>
      )}
      <SummaryRows summary={summary} />
    </>
  );
}

function SummaryRows({ summary }: { summary: SummaryRow[] }) {
  return (
    <dl className="trust-summary">
      {summary.map((row, i) => (
        <div key={`${i}:${row.label}`} className="trust-summary-row">
          <dt className="small muted">
            <bdi>{row.label}</bdi>
          </dt>
          <dd className="mono small break">
            <bdi>{row.value}</bdi>
            {row.host !== undefined && (
              <div className="trust-host">
                <span className="badge warn">接続先</span> <bdi>{row.host}</bdi>
              </div>
            )}
            {row.note !== undefined && <div className="trust-note">{row.note}</div>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FileList({ files, hash }: { files: string[]; hash: string }) {
  const body = (
    <>
      <ul className="plain-list small mono">
        {files.map((f) => (
          <li key={f} className="break">
            {f}
          </li>
        ))}
      </ul>
      <div className="muted small mono break" title="この中身のハッシュを信頼します">
        ハッシュ: {hash.slice(0, 16)}…
      </div>
    </>
  );
  if (files.length <= FILES_COLLAPSE) {
    return (
      <div className="trust-files">
        <div className="small muted">確認の対象のファイル（{files.length}）</div>
        {body}
      </div>
    );
  }
  return (
    <details className="trust-files">
      <summary className="small">確認の対象のファイル（{files.length}）</summary>
      {body}
    </details>
  );
}

