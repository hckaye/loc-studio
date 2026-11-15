/**
 * 呼び出しごとの利用者（Web モード）。AsyncLocalStorage で、呼び出しの間に動くすべての処理
 * （DB への書き込み、プラグインのホスト、ジョブ）から「いまの利用者」を引けるようにする。
 * 呼び出しの外（ローカルモード、コマンドライン）では undefined で、従来どおり PC のユーザー名を使う。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { SettingsLayers } from "@loc-studio/core";
import type { RoleDef } from "@loc-studio/sdk";
import type { CallContext } from "./api-types.js";

export interface CallState {
  call: CallContext;
  /** この利用者の設定の層（ローカル設定の代わりに利用者ごとの設定を使う）。 */
  layers?: SettingsLayers;
  /** プロジェクトの役割の定義。ないときは同梱の役割で確かめる。 */
  roles?: Readonly<Record<string, RoleDef>>;
}

const storage = new AsyncLocalStorage<CallState>();

export function currentCallState(): CallState | undefined {
  return storage.getStore();
}

export function currentCall(): CallContext | undefined {
  return storage.getStore()?.call;
}

export function runWithCall<T>(state: CallState | undefined, fn: () => T): T {
  return state ? storage.run(state, fn) : fn();
}

/**
 * システムの書き込み（フックが返した変更点の反映）。利用者の役割や遷移の制限を確かめず、フックも呼ばない。
 * 記録に残る名前は、きっかけになった利用者のまま。
 */
const system = new AsyncLocalStorage<true>();

export function runAsSystem<T>(fn: () => T): T {
  return system.run(true, fn);
}

export function isSystemWrite(): boolean {
  return system.getStore() === true;
}
