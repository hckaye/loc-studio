"use client";
import { useMemo, useState } from "react";
import { Dialog } from "@/components/Dialog";
import type { LanguageDef } from "@/lib/client/model";

/*
 * 言語の選択パネル。検索、グループ（LanguageDef.group、折りたためる）、表示セット（設定の languageSets と自分で保存したもの）、
 * 言語ごとの表示チェックとピン。適用するまで表には反映しない。
 */

export interface LanguagePickerProps {
  languages: LanguageDef[];
  projectSets: Record<string, string[]>;
  userSets: Record<string, string[]>;
  visible: string[];
  pins: string[];
  onApply(visible: string[], pins: string[]): void;
  onSaveSet(name: string, ids: string[]): void;
  onDeleteSet(name: string): void;
  onClose(): void;
  /** 言語を選ぶだけに使う（ピンと表示セットの保存を出さない）。担当の言語の選択など。 */
  selectOnly?: boolean;
  title?: string;
  /** 0 個の選択を許す（「すべて」の意味で使う場合など）。 */
  allowEmpty?: boolean;
}

const NO_GROUP = "";

export function LanguagePicker(props: LanguagePickerProps) {
  const { languages } = props;
  const [visible, setVisible] = useState<string[]>(props.visible);
  const [pins, setPins] = useState<string[]>(props.pins);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [setName, setSetName] = useState("");

  const q = query.trim().toLowerCase();
  const matches = (l: LanguageDef) => q === "" || l.label.toLowerCase().includes(q) || l.id.toLowerCase().includes(q) || (l.group ?? "").toLowerCase().includes(q);

  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, LanguageDef[]>();
    for (const l of languages) {
      const g = l.group ?? NO_GROUP;
      if (!map.has(g)) {
        map.set(g, []);
        order.push(g);
      }
      map.get(g)!.push(l);
    }
    // グループのない言語を先に
    order.sort((a, b) => (a === NO_GROUP ? -1 : b === NO_GROUP ? 1 : 0));
    return order.map((g) => ({ name: g, langs: map.get(g)! }));
  }, [languages]);

  const toggle = (id: string) => setVisible((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));
  const togglePin = (id: string) => {
    setPins((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
    // ピンした言語は表示する
    setVisible((v) => (v.includes(id) ? v : [...v, id]));
  };
  const applySet = (ids: string[]) => setVisible(languages.filter((l) => ids.includes(l.id)).map((l) => l.id));
  const setGroup = (langs: LanguageDef[], on: boolean) =>
    setVisible((v) => {
      const ids = langs.map((l) => l.id);
      return on ? [...new Set([...v, ...ids])] : v.filter((x) => !ids.includes(x));
    });

  const apply = () => {
    const vis = languages.filter((l) => visible.includes(l.id)).map((l) => l.id);
    props.onApply(vis, pins.filter((p) => vis.includes(p)));
    props.onClose();
  };

  const sets = [
    ...Object.entries(props.projectSets).map(([name, ids]) => ({ name, ids, user: false })),
    ...Object.entries(props.userSets).map(([name, ids]) => ({ name, ids, user: true })),
  ];

  return (
    <Dialog
      title={`${props.title ?? "言語の表示"}（${visible.length} / ${languages.length}）`}
      className="lang-picker"
      onClose={props.onClose}
      initialFocus="input[type=search]"
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            キャンセル
          </button>
          <button type="button" className="btn primary" onClick={apply} disabled={visible.length === 0 && !props.allowEmpty}>
            適用
          </button>
        </>
      }
    >
      <div className="lp-top">
        <input type="search" className="input" placeholder="言語を検索（名前・ID・グループ）" aria-label="言語を検索" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="btn small" onClick={() => setVisible(languages.map((l) => l.id))}>
          すべて
        </button>
        <button type="button" className="btn small" onClick={() => setVisible([])}>
          なし
        </button>
      </div>
      {sets.length > 0 && (
        <div className="lp-sets" role="group" aria-label="表示セット">
          <span className="muted small">表示セット:</span>
          {sets.map((s) => (
            <span key={`${s.user ? "u" : "p"}:${s.name}`} className="lp-set">
              <button type="button" className="btn small" onClick={() => applySet(s.ids)} title={s.ids.join(", ")}>
                {s.name}
                {s.user ? "" : " ★"}
              </button>
              {s.user && (
                <button type="button" className="icon-btn small" aria-label={`表示セット「${s.name}」を削除`} onClick={() => props.onDeleteSet(s.name)}>
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="lp-list" role="list">
        {groups.map((g) => {
          const shown = g.langs.filter(matches);
          if (shown.length === 0) return null;
          const isCollapsed = q === "" && collapsed[g.name] === true;
          const onCount = g.langs.filter((l) => visible.includes(l.id)).length;
          return (
            <div key={g.name || "@none"} className="lp-group" role="listitem">
              {g.name !== NO_GROUP && (
                <div className="lp-group-head">
                  <button
                    type="button"
                    className="lp-collapse"
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((c) => ({ ...c, [g.name]: !isCollapsed }))}
                  >
                    {isCollapsed ? "▸" : "▾"} {g.name}
                  </button>
                  <span className="muted small">
                    {onCount} / {g.langs.length}
                  </span>
                  <button type="button" className="btn small" onClick={() => setGroup(g.langs, onCount < g.langs.length)}>
                    {onCount < g.langs.length ? "すべて表示" : "すべて隠す"}
                  </button>
                </div>
              )}
              {!isCollapsed &&
                shown.map((l) => (
                  <div key={l.id} className={`lp-row${visible.includes(l.id) ? " on" : ""}`}>
                    <label className="lp-check">
                      <input type="checkbox" checked={visible.includes(l.id)} onChange={() => toggle(l.id)} />
                      <span>{l.label}</span>
                      <span className="muted small mono">{l.id}</span>
                      {l.basedOn && <span className="muted small">← {languages.find((x) => x.id === l.basedOn)?.label ?? l.basedOn}</span>}
                    </label>
                    {!props.selectOnly && <button
                      type="button"
                      className={`icon-btn small${pins.includes(l.id) ? " on" : ""}`}
                      aria-pressed={pins.includes(l.id)}
                      aria-label={`${l.label} を左に固定`}
                      title={pins.includes(l.id) ? "固定を外す" : "左に固定"}
                      onClick={() => togglePin(l.id)}
                    >
                      📌
                    </button>}
                  </div>
                ))}
            </div>
          );
        })}
        {languages.filter(matches).length === 0 && <p className="muted small">見つかりません。</p>}
      </div>
      {!props.selectOnly && <form
        className="lp-save"
        onSubmit={(e) => {
          e.preventDefault();
          const name = setName.trim();
          if (!name || visible.length === 0) return;
          props.onSaveSet(name, languages.filter((l) => visible.includes(l.id)).map((l) => l.id));
          setSetName("");
        }}
      >
        <input className="input" placeholder="いまの選択をセットとして保存" aria-label="表示セットの名前" value={setName} onChange={(e) => setSetName(e.target.value)} />
        <button type="submit" className="btn small" disabled={setName.trim() === "" || visible.length === 0}>
          保存
        </button>
      </form>}
    </Dialog>
  );
}
