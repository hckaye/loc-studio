"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CellInfo, IssueInfo, RowInfo, WorkspaceApi } from "@loc-studio/server";
import { COUNT_LABEL, countText } from "@/lib/client/count";
import { Dialog } from "@/components/Dialog";
import { draftByOther } from "@/components/grid/cells";
import { isRpcError } from "@/lib/client/api";
import { canEditCell, canEditText, canReview, optionProblem } from "@/lib/client/permissions";
import { Chip, EnumSelect } from "@/components/EnumSelect";
import { useStudio, useToasts } from "@/components/context";
import {
  cellIdOf,
  columnLabel,
  displayValue,
  enumDefault,
  enumOptions,
  findOption,
  gridKind,
  languageColumns,
  SEVERITY_LABEL,
  textValue,
  worstSeverity,
  type ColumnDef,
  type GridColumn,
  type LanguageDef,
} from "@/lib/client/model";

/*
 * 本文の編集モーダル。左に参照（基になる言語の本文、この言語の生成列）、右に編集欄と検証結果、下にこの言語の列。
 * Enter は改行、Ctrl+Enter で確定、Alt+↓ / Alt+↑ で確定して次 / 前の行、Esc で取消（変更があれば確認）。
 * 確定するとドラフト（未保存の変更）になる。リソースに書くのは保存のとき。
 */

export interface EditModalProps {
  resourceId: string;
  rowIndex: number;
  total: number;
  language: LanguageDef;
  textColumn: ColumnDef;
  loadRow(index: number): Promise<RowInfo | undefined>;
  onClose(): void;
  /** 表の行の位置を動かす（選択を合わせる）。 */
  onNavigate(index: number): void;
  /** 本文やほかの列の値が変わった。 */
  onCellsChanged(key: string, cells: Record<string, CellInfo>, unsaved?: number): void;
  /** 本文以外の列を変える（競合の扱いは呼び出し側）。 */
  onSetCell(row: RowInfo, gc: GridColumn, value: unknown): Promise<CellInfo | undefined>;
  onOpenReview(row: RowInfo, gc: GridColumn, verdict?: string): void;
}

function countLines(s: string): number {
  return s === "" ? 0 : s.split("\n").length;
}

type Token = Awaited<ReturnType<WorkspaceApi["tokens"]>>[number][number];

/** 本文を、変数・タグ・制御コードに色を付けて出す（トークンがまだなければ、そのまま出す）。 */
function TokenText({ text, tokens }: { text: string; tokens: Token[] | undefined }) {
  if (!tokens) return <>{text}</>;
  return (
    <>
      {tokens.map((t, i) =>
        t.kind === "text" ? (
          <span key={i}>{t.value}</span>
        ) : (
          <span key={i} className={`tok tok-${t.kind}`} data-token={t.kind}>
            {t.value}
          </span>
        ),
      )}
    </>
  );
}

export function EditModal(props: EditModalProps) {
  const { api, info } = useStudio();
  const { push, reportError } = useToasts();
  const { language, textColumn, resourceId } = props;
  const cellId = cellIdOf(textColumn, language.id);
  const [index, setIndex] = useState(props.rowIndex);
  const [row, setRow] = useState<RowInfo | undefined>();
  const [detail, setDetail] = useState<RowInfo | undefined>();
  const [draft, setDraft] = useState("");
  const [initial, setInitial] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [issues, setIssues] = useState<IssueInfo[]>([]);
  const [validating, setValidating] = useState(false);
  const validateSeq = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editAllowed = canEditText(info, language.id);
  const readOnly = !editAllowed.ok;
  // 同じセルを別の人が先に確定したとき（Web モードの共有のドラフト）
  const [draftConflict, setDraftConflict] = useState<{ value: string; by?: string; step?: 1 | -1 } | null>(null);
  // 検証結果の範囲に下線を引くための、検証した本文（いまの本文と同じときだけ下線を出す）と IME の変換中かどうか
  const [validatedText, setValidatedText] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const changed = draft !== initial;

  const load = useCallback(
    async (i: number) => {
      setBusy(true);
      try {
        const r = await props.loadRow(i);
        if (!r) throw new Error(`${i + 1} 行目を読み込めませんでした。`);
        setRow(r);
        const v = textValue(r.cells[cellId]);
        setDraft(v);
        setInitial(v);
        validateSeq.current++;
        setIssues(r.cells[cellId]?.issues ?? []);
        setValidatedText(v);
        setValidating(false);
        setConfirmDiscard(false);
        setDetail(undefined);
        // 参照（基になる言語は表示していないこともある）は全言語の行から
        api
          .rowDetail({ resourceId, key: r.key })
          .then((d) => setDetail(d.row))
          .catch((err: unknown) => reportError(err, "参照の読み込み"));
        requestAnimationFrame(() => textareaRef.current?.focus());
      } catch (err) {
        reportError(err);
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, resourceId, cellId],
  );

  useEffect(() => {
    void load(index);
  }, [index, load]);

  // 入力中の本文を確かめる（保存はしない）。止まってから 250 ミリ秒後に呼び、古い応答は捨てる。
  const rowKey = row?.key;
  useEffect(() => {
    if (rowKey === undefined || draft === initial) return;
    const seq = ++validateSeq.current;
    setValidating(true);
    const t = setTimeout(() => {
      api
        .validateText({ resourceId, key: rowKey, language: language.id, value: draft })
        .then((list) => {
          if (validateSeq.current === seq) {
            setIssues(list);
            setValidatedText(draft);
          }
        })
        .catch((err: unknown) => {
          if (validateSeq.current === seq) reportError(err, "検証できませんでした");
        })
        .finally(() => {
          if (validateSeq.current === seq) setValidating(false);
        });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, rowKey]);

  const base = useMemo(() => (language.basedOn ? info.languages.find((l) => l.id === language.basedOn) : undefined), [info, language]);
  const baseText = base && detail ? textValue(detail.cells[cellIdOf(textColumn, base.id)]) : undefined;
  const langCols = useMemo(() => languageColumns(info, language.id).filter((c) => c.kind !== "text"), [info, language.id]);
  const editableCols = langCols.filter((c) => c.kind !== "generated" && c.kind !== "actions");
  const editorConfig = info.editor;
  // 参照欄の言語: 基になる言語と、設定の editor.referenceLanguages（編集中の言語と、重なりは除く）。
  const refLanguages = useMemo(() => {
    const ids = [...(base ? [base.id] : []), ...(editorConfig?.referenceLanguages ?? [])].filter((id, i, all) => id !== language.id && all.indexOf(id) === i);
    return ids.flatMap((id) => info.languages.find((l) => l.id === id) ?? []);
  }, [info.languages, base, editorConfig, language.id]);
  // 参照欄の列: 設定の editor.referenceColumns。書かれていなければ、この言語の生成列。
  const refColumns = useMemo(() => {
    const ids = editorConfig?.referenceColumns;
    if (!ids) return langCols.filter((c) => c.kind === "generated");
    return ids.flatMap((id) => info.columns.find((c) => c.id === id && (c.scope === "entry" || langCols.includes(c))) ?? []);
  }, [info.columns, editorConfig, langCols]);

  // 参照の本文のトークン（変数・タグの色分けと、訳文への差し込み用）。本文 → トークン。
  const [refTokens, setRefTokens] = useState<Record<string, Token[]>>({});
  const refTexts = useMemo(
    () => (detail ? refLanguages.map((l) => textValue(detail.cells[cellIdOf(textColumn, l.id)])).filter((t) => t !== "") : []),
    [detail, refLanguages, textColumn],
  );
  const refTextsKey = refTexts.join("\u0000");
  useEffect(() => {
    if (refTexts.length === 0) return;
    let cancelled = false;
    api
      .tokens({ resourceId, texts: refTexts })
      .then((lists) => {
        if (!cancelled) setRefTokens(Object.fromEntries(refTexts.map((t, i) => [t, lists[i] ?? []])));
      })
      .catch((err: unknown) => reportError(err, "変数・タグの読み込み"));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, resourceId, refTextsKey]);
  // 基の本文にある変数・タグ・制御コード（重なりを除く）。押すと訳文のカーソルの位置に入れる。
  const insertable = useMemo(() => {
    const tokens = baseText ? refTokens[baseText] : undefined;
    return [...new Set((tokens ?? []).filter((t) => t.kind !== "text").map((t) => t.value))];
  }, [baseText, refTokens]);
  const insertToken = (value: string) => {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? draft.length;
    const end = ta?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, start) + value + draft.slice(end));
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(start + value.length, start + value.length);
    });
  };

  // 長さの数え方（設定の editor.count）。skipTokens のときは、入力が止まってから本文をトークンに分けて、文字の部分だけ数える。
  const countUnit = editorConfig?.count.unit ?? "codepoints";
  const skipTokens = editorConfig?.count.skipTokens === true;
  const [draftTokens, setDraftTokens] = useState<{ text: string; tokens: Token[] } | null>(null);
  useEffect(() => {
    if (!skipTokens || draft === "") return;
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .tokens({ resourceId, texts: [draft] })
        .then(([tokens]) => {
          if (!cancelled) setDraftTokens({ text: draft, tokens: tokens ?? [] });
        })
        .catch((err: unknown) => reportError(err, "本文の長さの計算"));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, resourceId, draft, skipTokens]);
  const counted = skipTokens && draftTokens?.text === draft ? draftTokens.tokens.filter((t) => t.kind === "text").map((t) => t.value).join("") : draft;
  // 変数を除いて数える設定で、いまの本文のトークンがまだないあいだは「計算中」と分かるようにする。
  const countPending = skipTokens && draft !== "" && draftTokens?.text !== draft;

  /**
   * 確定する。step があれば、そのあと前後の行へ。
   * 編集を始めたときの値を baseValue に渡し、そのあいだにほかの人が同じセルを確定していたら上書きせずに確かめる。
   * base を渡すと、その値を基にして確定する（「自分の変更で上書きする」）。
   */
  const confirm = async (step?: 1 | -1, base?: string) => {
    if (!row || busy) return;
    setBusy(true);
    try {
      if ((changed || base !== undefined) && !readOnly) {
        let res;
        try {
          res = await api.setText({ resourceId, key: row.key, language: language.id, value: draft, baseValue: base ?? initial });
        } catch (err) {
          if (isRpcError(err, "conflict")) {
            const data = (err.data ?? {}) as { value?: unknown; by?: unknown };
            setDraftConflict({
              value: typeof data.value === "string" ? data.value : "",
              ...(typeof data.by === "string" ? { by: data.by } : {}),
              ...(step !== undefined ? { step } : {}),
            });
            setBusy(false);
            return;
          }
          throw err;
        }
        props.onCellsChanged(row.key, { [cellId]: res.cell }, res.unsaved);
        const issues = res.cell.issues ?? [];
        validateSeq.current++;
        setIssues(issues);
        setValidatedText(draft);
        const worst = worstSeverity(issues);
        if (worst === "error" || worst === "warning") {
          push("warning", `${row.key}（${language.label}）: ${SEVERITY_LABEL[worst]}を含む ${issues.length} 件の問題があります`);
        }
      }
      if (step !== undefined) {
        const next = index + step;
        if (next < 0 || next >= props.total) {
          setBusy(false);
          if (step === 1) props.onClose();
          return;
        }
        props.onNavigate(next);
        setBusy(false);
        setIndex(next);
        return;
      }
      setBusy(false);
      props.onClose();
    } catch (err) {
      setBusy(false);
      reportError(err, "確定できませんでした");
    }
  };

  const cancel = () => {
    if (changed && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    props.onClose();
  };

  const onTextKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME の変換中のキーは確定や移動に使わない
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void confirm();
    } else if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      void confirm(1);
    } else if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      void confirm(-1);
    }
  };

  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.target === textareaRef.current) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void confirm();
    } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      void confirm(e.key === "ArrowDown" ? 1 : -1);
    }
  };

  const selectRange = (issue: IssueInfo) => {
    const ta = textareaRef.current;
    if (!ta || !issue.range) return;
    ta.focus();
    ta.setSelectionRange(issue.range.start, issue.range.end);
  };

  const cellNow = row?.cells[cellId];
  /** このセルのドラフトを取り消す（保存済みの値に戻す。ほかの言語のドラフトは残す）。 */
  const revertDraft = async () => {
    if (!row || !cellNow?.draft) return;
    setBusy(true);
    try {
      const saved = cellNow.saved ?? "";
      const res = await api.setText({ resourceId, key: row.key, language: language.id, value: saved });
      props.onCellsChanged(row.key, { [cellId]: res.cell }, res.unsaved);
      setRow({ ...row, cells: { ...row.cells, [cellId]: res.cell } });
      setDraft(saved);
      setInitial(saved);
      validateSeq.current++;
      setIssues(res.cell.issues ?? []);
      setValidatedText(saved);
      setConfirmDiscard(false);
      push("success", "変更を取り消しました");
    } catch (err) {
      reportError(err, "取り消せませんでした");
    } finally {
      setBusy(false);
    }
  };

  const gcOf = (col: ColumnDef): GridColumn => ({ cellId: cellIdOf(col, language.id), col, kind: gridKind(col), language: language.id, groupId: `lang:${language.id}`, width: 0 });

  const otherEditor = draftByOther(cellNow, info.user.name);
  const title = (
    <span className="edit-title">
      <span className="mono">{row?.key ?? "…"}</span>
      <span className="edit-lang">{language.label}</span>
      <span className="muted small">
        {index + 1} / {props.total}
      </span>
      {otherEditor && <span className="badge warn">{otherEditor}さんが編集中</span>}
    </span>
  );
  const underlines = !composing && validatedText === draft ? issueSegments(draft, issues) : null;

  return (
    <Dialog
      title={title}
      ariaLabel="本文の編集"
      className="edit-modal"
      onClose={props.onClose}
      onEscape={cancel}
      initialFocus="textarea"
      headerExtra={
        <span className="edit-nav">
          <button type="button" className="btn small" aria-label="前の行（確定して移動）" title="前の行（Alt+↑）" disabled={index <= 0 || busy} onClick={() => void confirm(-1)}>
            ↑ 前
          </button>
          <button type="button" className="btn small" aria-label="次の行（確定して移動）" title="次の行（Alt+↓）" disabled={index >= props.total - 1 || busy} onClick={() => void confirm(1)}>
            ↓ 次
          </button>
        </span>
      }
      footer={
        confirmDiscard ? (
          <div className="confirm-bar" role="alertdialog" aria-label="変更の破棄の確認">
            <span>変更を破棄して閉じますか？</span>
            <button type="button" className="btn" onClick={() => setConfirmDiscard(false)}>
              編集に戻る
            </button>
            <button type="button" className="btn danger" onClick={props.onClose}>
              破棄して閉じる
            </button>
          </div>
        ) : (
          <>
            <span className="muted small footer-hint">Enter で改行</span>
            <button type="button" className="btn" onClick={cancel}>
              キャンセル <kbd>Esc</kbd>
            </button>
            <button type="button" className="btn" disabled={busy || readOnly} title={editAllowed.reason} onClick={() => void confirm(1)}>
              確定して次の行へ <kbd>Alt+↓</kbd>
            </button>
            <button type="button" className="btn primary" disabled={busy || readOnly} title={editAllowed.reason} onClick={() => void confirm()}>
              確定 <kbd>Ctrl+Enter</kbd>
            </button>
          </>
        )
      }
    >
      <div className="edit-body" onKeyDown={onDialogKeyDown}>
        <section className="edit-refs" aria-label="参照">
          <h3 className="pane-title">参照</h3>
          {!base && <p className="muted small">この言語は原文です（基になる言語はありません）。</p>}
          {refLanguages.map((l) => {
            const text = detail ? textValue(detail.cells[cellIdOf(textColumn, l.id)]) : undefined;
            return (
              <div className="ref-block" key={l.id}>
                <div className="ref-label">
                  {l.label} {l.id === base?.id && <span className="muted small">（基になる言語）</span>}
                </div>
                <div className="ref-text" {...(l.hint?.dir ? { dir: l.hint.dir } : {})} {...(l.hint?.lang ? { lang: l.hint.lang } : {})}>
                  {text === undefined ? "読み込み中…" : text === "" ? <span className="muted">（空）</span> : <TokenText text={text} tokens={refTokens[text]} />}
                </div>
              </div>
            );
          })}
          {insertable.length > 0 && !readOnly && (
            <div className="ref-block">
              <div className="ref-label">
                原文の変数・タグ <span className="muted small">（押すと本文のカーソルの位置に入れます）</span>
              </div>
              <div className="tok-chips">
                {insertable.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`tok-chip${draft.includes(value) ? "" : " missing"}`}
                    aria-label={`${value} を本文に入れる`}
                    title={draft.includes(value) ? "本文にあります" : "本文にまだありません"}
                    onClick={() => insertToken(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
          )}
          {refColumns.map((c) => {
            const id = cellIdOf(c, c.scope === "language" ? language.id : undefined);
            const cell = detail?.cells[id] ?? row?.cells[id];
            const state = cell?.generated ?? "missing";
            const option = findOption(c, cell?.value);
            return (
              <div className="ref-block" key={c.id}>
                <div className="ref-label">
                  {columnLabel(c)}{" "}
                  {c.kind === "generated" && <span className={`gen-badge gen-badge-${state}`}>{state === "fresh" ? "最新" : state === "stale" ? "古い" : "未生成"}</span>}
                </div>
                <div className="ref-text">{option ? <Chip option={option} /> : displayValue(cell?.value) || <span className="muted">（なし）</span>}</div>
              </div>
            );
          })}
        </section>
        <section className="edit-main" aria-label="編集">
          <label className="pane-title" htmlFor="edit-textarea">
            {language.label} の本文{readOnly && <span className="badge" title={editAllowed.reason}>{editAllowed.reason}</span>}
            {row?.cells[cellId]?.needsRecheck && <span className="badge warn">要確認: 基の本文が変わりました</span>}
          </label>
          <div className="edit-text-wrap">
            {/* 検証結果の範囲の下線。textarea と同じ字形・折り返しで後ろに重ね、スクロールを合わせる */}
            <div
              ref={overlayRef}
              className="edit-overlay"
              aria-hidden="true"
              {...(language.hint?.dir ? { dir: language.hint.dir } : {})}
              style={language.hint?.font ? { fontFamily: language.hint.font } : undefined}
            >
              {underlines
                ? underlines.map((seg, i) =>
                    seg.severity ? (
                      <mark key={i} className={`ul ul-${seg.severity}`} data-severity={seg.severity}>
                        {seg.text}
                      </mark>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    ),
                  )
                : draft}
              {"\n"}
            </div>
            <textarea
              id="edit-textarea"
              ref={textareaRef}
              className="edit-textarea"
              value={draft}
              readOnly={readOnly}
              title={readOnly ? editAllowed.reason : undefined}
              spellCheck={false}
              {...(language.hint?.dir ? { dir: language.hint.dir } : {})}
              {...(language.hint?.lang ? { lang: language.hint.lang } : {})}
              style={language.hint?.font ? { fontFamily: language.hint.font } : undefined}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onTextKeyDown}
              onScroll={(e) => {
                if (overlayRef.current) {
                  overlayRef.current.scrollTop = e.currentTarget.scrollTop;
                  overlayRef.current.scrollLeft = e.currentTarget.scrollLeft;
                }
              }}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
            />
          </div>
          <div className="edit-counts" aria-live="polite">
            <span data-count-unit={countUnit} title={skipTokens ? "変数・タグを除いて数えています" : undefined}>
              {countPending ? "…" : countText(counted, countUnit)} {COUNT_LABEL[countUnit]}
            </span>
            <span>{countLines(draft)} 行</span>
            {changed && <span className="mark-unsaved-text">● 編集中</span>}
            {!changed && cellNow?.draft && <span className="mark-unsaved-text">● 未保存の変更あり</span>}
            {cellNow?.draft && !readOnly && (
              <button type="button" className="btn small" disabled={busy} onClick={() => void revertDraft()} title="未保存の変更を捨てて、保存済みの値に戻す">
                変更を取り消す
              </button>
            )}
          </div>
          <div className="issues" aria-label="検証結果">
            <div className="issues-head">
              検証結果{validating && <span className="spinner small" aria-label="確認中" />}
            </div>
            {issues.length === 0 ? (
              <div className="muted small">{validating ? "確認中…" : "問題はありません"}</div>
            ) : (
              <ul className="issue-list">
                {issues.map((iss, i) => (
                  <li key={`${iss.validatorId}-${iss.code}-${i}`} className={`issue sev-${iss.severity}`}>
                    <button type="button" className="issue-msg" onClick={() => selectRange(iss)} disabled={!iss.range} title={iss.range ? "該当箇所を選択" : undefined}>
                      <span className={`sev-badge sev-${iss.severity}`}>{SEVERITY_LABEL[iss.severity]}</span>
                      {iss.message}
                    </button>
                    {iss.fix && !readOnly && (
                      <button type="button" className="btn small" onClick={() => setDraft(iss.fix!.value)}>
                        {iss.fix.label}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
      {row && editableCols.length > 0 && (
        <section className="edit-cols" aria-label={`${language.label} の列`}>
          {editableCols.map((c) => {
            const gc = gcOf(c);
            const cell = row.cells[gc.cellId] ?? detail?.cells[gc.cellId];
            const options = enumOptions(c);
            const raw = cell?.value;
            const value = raw === undefined || raw === null || raw === "" ? enumDefault(c) : String(raw);
            return (
              <div className="edit-col" key={c.id}>
                <span className="edit-col-label">{columnLabel(c)}</span>
                {c.kind === "review" ? (
                  <>
                    <Chip option={findOption(c, raw)} fallback={value ?? "—"} {...(cell?.stale ? { stale: true } : {})} />
                    <button
                      type="button"
                      className="btn small"
                      disabled={!canReview(info, language.id).ok}
                      title={canReview(info, language.id).reason}
                      onClick={() => props.onOpenReview(row, gc)}
                    >
                      レビューを投稿
                    </button>
                  </>
                ) : options ? (
                  <EnumSelect
                    options={options}
                    value={value}
                    label={columnLabel(c)}
                    {...(cell?.stale ? { stale: true } : {})}
                    {...(!canEditCell(info, gc).ok ? { disabled: true, title: canEditCell(info, gc).reason } : {})}
                    optionProblem={(o) => optionProblem(info, c, o, raw)}
                    onChoose={(v) => {
                      void props.onSetCell(row, gc, v).then((updated) => {
                        if (updated) setRow((r) => (r ? { ...r, cells: { ...r.cells, [gc.cellId]: updated } } : r));
                      });
                    }}
                  />
                ) : gc.kind === "string" || gc.kind === "number" ? (
                  <MetaInput
                    key={`${row.key}:${gc.cellId}:${displayValue(cell?.value)}`}
                    label={columnLabel(c)}
                    kind={gc.kind}
                    {...(c.type === "date" ? { date: true } : {})}
                    initial={displayValue(cell?.value)}
                    disabledReason={canEditCell(info, gc).ok ? undefined : canEditCell(info, gc).reason}
                    onCommit={(v) => {
                      void props.onSetCell(row, gc, v).then((updated) => {
                        if (updated) setRow((r) => (r ? { ...r, cells: { ...r.cells, [gc.cellId]: updated } } : r));
                      });
                    }}
                  />
                ) : gc.kind === "boolean" ? (
                  <input
                    type="checkbox"
                    aria-label={columnLabel(c)}
                    checked={cell?.value === true}
                    disabled={!canEditCell(info, gc).ok}
                    title={canEditCell(info, gc).reason}
                    onChange={(e) => {
                      void props.onSetCell(row, gc, e.target.checked).then((updated) => {
                        if (updated) setRow((r) => (r ? { ...r, cells: { ...r.cells, [gc.cellId]: updated } } : r));
                      });
                    }}
                  />
                ) : (
                  <span className="cell-value">{displayValue(cell?.value)}</span>
                )}
              </div>
            );
          })}
        </section>
      )}
      {draftConflict && row && (
        <Dialog
          title="ほかの人が先にこのセルを変更しました"
          className="small-dialog wide"
          onClose={() => setDraftConflict(null)}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setDraftConflict(null);
                  // 相手の変更を使う: いまの値（相手のドラフト）を読み直して編集欄に入れる
                  void load(index);
                }}
              >
                相手の変更を使う
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  const c = draftConflict;
                  setDraftConflict(null);
                  // いまの値を基にして、もう一度確定する（そのあいだにまた変わっていれば、もう一度知らせる）
                  void confirm(c.step, c.value);
                }}
              >
                自分の変更で上書きする
              </button>
            </>
          }
        >
          <p>
            編集しているあいだに、<strong>{draftConflict.by ? `${draftConflict.by}さん` : "ほかの人"}</strong>がこのセルを確定しました。どちらを残しますか？
          </p>
          <div className="conflict-values">
            <div>
              <div className="muted small">{draftConflict.by ? `${draftConflict.by}さんの変更` : "相手の変更"}</div>
              <div className="ref-text">{draftConflict.value || <span className="muted">（空）</span>}</div>
            </div>
            <div>
              <div className="muted small">自分の変更</div>
              <div className="ref-text">{draft || <span className="muted">（空）</span>}</div>
            </div>
          </div>
        </Dialog>
      )}
    </Dialog>
  );
}

const SEV_RANK = { error: 3, warning: 2, info: 1 } as const;
type Sev = keyof typeof SEV_RANK;

/** 本文を、検証結果の範囲ごとの区切りに分ける（重なったところは重いほう）。 */
export function issueSegments(text: string, issues: IssueInfo[]): { text: string; severity?: Sev }[] {
  const ranged = issues.filter((i) => i.range && i.range.end > i.range.start && i.range.start < text.length);
  if (ranged.length === 0) return [{ text }];
  const sev: (Sev | undefined)[] = new Array(text.length);
  for (const i of ranged) {
    const end = Math.min(text.length, i.range!.end);
    for (let k = Math.max(0, i.range!.start); k < end; k++) {
      const cur = sev[k];
      if (!cur || SEV_RANK[i.severity] > SEV_RANK[cur]) sev[k] = i.severity;
    }
  }
  const out: { text: string; severity?: Sev }[] = [];
  let start = 0;
  for (let k = 1; k <= text.length; k++) {
    if (k === text.length || sev[k] !== sev[start]) {
      const seg = text.slice(start, k);
      const s = sev[start];
      out.push(s ? { text: seg, severity: s } : { text: seg });
      start = k;
    }
  }
  return out;
}

/** 文字・数値の列の入力欄。表のセルと同じく Enter で保存、Esc で元に戻す（モーダルは閉じない）。 */
function MetaInput({
  label,
  kind,
  date,
  initial,
  onCommit,
  disabledReason,
}: {
  label: string;
  kind: "string" | "number";
  /** 日付の列（日付の入力欄にし、空にしたら値を消す）。 */
  date?: boolean;
  initial: string;
  onCommit(v: unknown): void;
  disabledReason?: string | undefined;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const changed = value !== initial;
  const commit = () => {
    if (kind === "number") {
      if (value.trim() === "") return onCommit(null);
      const n = Number(value);
      if (Number.isNaN(n)) return setError("数値を入力してください");
      setError(null);
      return onCommit(n);
    }
    if (date && value === "") return onCommit(null);
    onCommit(value);
  };
  return (
    <span className="meta-input">
      <input
        className={`input small${changed ? " changed" : ""}`}
        aria-label={label}
        {...(date ? { type: "date" } : {})}
        value={value}
        inputMode={kind === "number" ? "decimal" : undefined}
        disabled={disabledReason !== undefined}
        title={disabledReason ?? "Enter で保存、Esc で元に戻す"}
        onChange={(e) => {
          setError(null);
          setValue(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            if (changed) commit();
          } else if (e.key === "Escape" && changed) {
            e.preventDefault();
            e.stopPropagation();
            setValue(initial);
            setError(null);
          }
        }}
      />
      {changed && <span className="muted small">Enter で保存</span>}
      {error && <span className="hint-error">{error}</span>}
    </span>
  );
}
