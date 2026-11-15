/**
 * 呼び出しごとの利用者（Web モード）。AsyncLocalStorage で、呼び出しの間に動くすべての処理
 * （DB への書き込み、プラグインのホスト、ジョブ）から「いまの利用者」を引けるようにする。
 * 呼び出しの外（ローカルモード、コマンドライン）では undefined で、従来どおり PC のユーザー名を使う。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { SettingsLayers } from "@loc-studio/core";
import type { CallContext } from "./api-types.js";

export interface CallState {
  call: CallContext;
  /** この利用者の設定の層（ローカル設定の代わりに利用者ごとの設定を使う）。 */
  layers?: SettingsLayers;
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
