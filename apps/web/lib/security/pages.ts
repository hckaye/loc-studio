/* 守りの仕組みが返す、短い HTML のページ（スクリプトなし）。 */

const STYLE =
  "body{font-family:'Noto Sans JP','Hiragino Sans','Yu Gothic UI',Meiryo,system-ui,sans-serif;background:#f4f5f7;color:#1b1f24;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}" +
  "main{background:#fff;border:1px solid #dde1e6;border-radius:10px;padding:24px 28px;max-width:560px;box-shadow:0 6px 24px rgba(27,31,36,.12)}" +
  "h1{font-size:18px;margin:0 0 12px}p{line-height:1.7;font-size:14px}code{background:#f4f5f7;border:1px solid #dde1e6;border-radius:4px;padding:1px 5px;font-size:13px}";

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

/** ローカルモードで、起動の合言葉のクッキーがないとき。 */
export function localTokenPage(): string {
  return page(
    "loc-studio を開くには",
    `<h1>loc-studio を開くには</h1>
<p>このページは、loc-studio を起動したときに表示された URL（<code>?token=…</code> の付いたもの）から開いてください。</p>
<p>起動したターミナルに <code>loc-studio: http://127.0.0.1:…/?token=…</code> の形で表示されています。デスクトップ版では、アプリが自動で開きます。</p>
<p>サーバーを起動し直した場合は、新しく表示された URL から開き直してください（URL はほかの人に教えないでください）。</p>`,
  );
}

export function misconfiguredPage(): string {
  return page("loc-studio は動いていません", `<h1>loc-studio は動いていません</h1><p>サーバーの設定に問題があるため、要求を受け付けていません。起動した人はサーバーのログを確認してください。</p>`);
}
