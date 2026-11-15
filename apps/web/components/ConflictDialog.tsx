"use client";
import { Dialog } from "@/components/Dialog";
import { Chip } from "@/components/EnumSelect";
import { columnLabel, displayValue, findOption, formatTime, type ColumnDef } from "@/lib/client/model";
import type { ConflictCurrent } from "@/lib/client/conflict";

/* 同じセルをほかの人が先に変えたとき。両方の値を見せて、どちらにするか選んでもらう。 */
export interface ConflictDialogProps {
  col: ColumnDef;
  rowKey: string;
  mine: unknown;
  current: ConflictCurrent | undefined;
  onUseMine(): void;
  onUseCurrent(): void;
}

export function ConflictDialog({ col, rowKey, mine, current, onUseMine, onUseCurrent }: ConflictDialogProps) {
  const show = (v: unknown) => {
    const o = findOption(col, v);
    return o ? <Chip option={o} /> : <span>{displayValue(v) || "（空）"}</span>;
  };
  return (
    <Dialog
      title="ほかの人が先に変更しました"
      className="small-dialog"
      onClose={onUseCurrent}
      footer={
        <>
          <button type="button" className="btn" onClick={onUseCurrent}>
            いまの値を使う
          </button>
          <button type="button" className="btn primary" onClick={onUseMine}>
            自分の値で上書き
          </button>
        </>
      }
    >
      <p>
        <span className="mono">{rowKey}</span> の「{columnLabel(col)}」は、読み込んだあとで変更されています。
      </p>
      <table className="kv">
        <tbody>
          <tr>
            <th>いまの値</th>
            <td>
              {show(current?.value)}
              {current?.updatedBy && (
                <span className="muted small">
                  {" "}
                  {current.updatedBy} {formatTime(current.updatedAt)}
                </span>
              )}
            </td>
          </tr>
          <tr>
            <th>あなたの値</th>
            <td>{show(mine)}</td>
          </tr>
        </tbody>
      </table>
    </Dialog>
  );
}
