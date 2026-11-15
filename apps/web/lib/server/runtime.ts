/*
 * サービス層を実行時に読み込む。
 * ワークスペースのパッケージはシンボリックリンクなので、Next（Turbopack）は serverExternalPackages に書いても
 * バンドルしてしまう。プラグインは実行時にプラグインフォルダから読み込み、配布したビルドの隣に置いたコードが
 * 再ビルドなしで動く必要があるので、静的に解析されない import で Node に解決させる。
 * standalone の出力には next.config.mjs の outputFileTracingIncludes でパッケージを含める。
 * Next を更新したらこの仕組みが効かなくなることがあるので、scripts/smoke.mjs がサーバーのチャンクに
 * サービス層のコードが入っていないことを確かめている。
 */
type ServerModule = typeof import("@loc-studio/server");
type CoreModule = typeof import("@loc-studio/core");

let serverMod: Promise<ServerModule> | undefined;
let coreMod: Promise<CoreModule> | undefined;

export function loadServer(): Promise<ServerModule> {
  serverMod ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "@loc-studio/server") as Promise<ServerModule>;
  return serverMod;
}

export function loadCore(): Promise<CoreModule> {
  coreMod ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "@loc-studio/core") as Promise<CoreModule>;
  return coreMod;
}
