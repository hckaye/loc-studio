"use client";
import { useState } from "react";
import type { WorkspaceApi } from "@loc-studio/server";
import { Dialog } from "@/components/Dialog";
import { useStudio, useToasts } from "@/components/context";

/* 行の追加・キーの変更・削除と、リソースの作成のダイアログ。どれも確定するとすぐリソースに書く。 */

export type StructureRequest =
  | { kind: "add"; resourceId: string; after?: string }
  | { kind: "rename"; resourceId: string; key: string }
  | { kind: "remove"; resourceId: string; keys: string[] }
  | { kind: "resource"; near?: string };

type ResourceRef = Awaited<ReturnType<WorkspaceApi["createResource"]>>["resource"];

export interface StructureDialogProps {
  request: StructureRequest;
  onClose(): void;
  /** 変更が済んだ。created は作ったリソース、key は足した・変えた行のキー。 */
  onDone(result: { message: string; created?: ResourceRef; key?: string }): void;
}

/** 選んでいるリソースと同じフォルダを、新しいリソースの場所の初期値にする。 */
const folderOf = (resourcePath: string | undefined): string => (resourcePath && resourcePath.includes("/") ? resourcePath.slice(0, resourcePath.lastIndexOf("/") + 1) : "");

export function StructureDialog({ request, onClose, onDone }: StructureDialogProps) {
  const { api } = useStudio();
  const { reportError } = useToasts();
  const [value, setValue] = useState(request.kind === "rename" ? request.key : request.kind === "resource" ? folderOf(request.near) : "");
  const [busy, setBusy] = useState(false);
  const text = value.trim();

  const run = async () => {
    setBusy(true);
    try {
      if (request.kind === "add") {
        await api.editEntries({ resourceId: request.resourceId, changes: [{ type: "add", key: text, ...(request.after !== undefined ? { after: request.after } : {}) }] });
        onDone({ message: `行「${text}」を追加しました`, key: text });
      } else if (request.kind === "rename") {
        await api.editEntries({ resourceId: request.resourceId, changes: [{ type: "rename", key: request.key, newKey: text }] });
        onDone({ message: `キーを「${text}」に変えました`, key: text });
      } else if (request.kind === "remove") {
        await api.editEntries({ resourceId: request.resourceId, changes: request.keys.map((key) => ({ type: "remove" as const, key })) });
        onDone({ message: `${request.keys.length} 行を削除しました` });
      } else {
        const { resource } = await api.createResource({ path: text });
        onDone({ message: `リソース「${resource.path}」を作りました`, created: resource });
      }
    } catch (err) {
      reportError(err, TITLE[request.kind]);
      setBusy(false);
    }
  };

  const needsText = request.kind !== "remove";
  const unchanged = request.kind === "rename" && text === request.key;
  const disabled = busy || (needsText && (text === "" || unchanged));

  return (
    <Dialog
      title={TITLE[request.kind]}
      className="small-dialog"
      onClose={onClose}
      initialFocus="input"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            やめる
          </button>
          <button type="button" className={request.kind === "remove" ? "btn danger" : "btn primary"} disabled={disabled} onClick={() => void run()}>
            {CONFIRM[request.kind]}
          </button>
        </>
      }
    >
      {request.kind === "remove" ? (
        <>
          <p>次の {request.keys.length} 行を、リソースから削除します。すぐリソースに書き込み、元に戻せません。</p>
          <p className="mono small">{request.keys.slice(0, 10).join("、")}{request.keys.length > 10 ? ` ほか ${request.keys.length - 10} 行` : ""}</p>
          <p className="muted small">ステータスやレビューの記録は残り、同じキーの行を足し直すと戻ります。未保存の編集は捨てます。</p>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!disabled) void run();
          }}
        >
          <label className="field">
            <span>{LABEL[request.kind]}</span>
            <input className="input mono" value={value} onChange={(e) => setValue(e.target.value)} aria-label={LABEL[request.kind]} spellCheck={false} />
          </label>
          {request.kind === "add" && <p className="muted small">{request.after !== undefined ? `「${request.after}」の後ろに足します。` : "末尾に足します。"}すぐリソースに書き込みます。</p>}
          {request.kind === "rename" && <p className="muted small">ステータス、レビュー、履歴、未保存の編集は、新しいキーに引き継ぎます。すぐリソースに書き込みます。</p>}
          {request.kind === "resource" && <p className="muted small">場所は、拡張子まで含めて書きます（例: Assets/Text/dlc/new.csv）。見出しだけのリソースを作ります。</p>}
        </form>
      )}
    </Dialog>
  );
}

const TITLE = { add: "行を追加", rename: "キーを変更", remove: "行を削除", resource: "リソースを作成" } as const;
const CONFIRM = { add: "追加する", rename: "変更する", remove: "削除する", resource: "作成する" } as const;
const LABEL = { add: "新しい行のキー", rename: "新しいキー", resource: "リソースの場所" } as const;
