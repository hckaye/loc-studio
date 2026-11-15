/**
 * フック（WorkflowHook）の呼び出し。設定の `hooks` に書いた順に、書き込みの前（before）とあと（after）に呼ぶ。
 * after が返した変更点は、利用者の役割にかかわらず反映する（システムの変更）。その変更ではフックを呼ばない。
 */
import type { CellPatch, Options, WorkflowContext, WorkflowEvent, WorkflowHook } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import { isSystemWrite, runAsSystem } from "./call-context.js";
import type { WsContext } from "./context.js";
import { errorText, normalizeUse } from "./context.js";

interface ResolvedHook {
  hook: WorkflowHook;
  options: Options;
}

function hooksFor(ctx: WsContext, type: WorkflowEvent["type"]): ResolvedHook[] {
  const out: ResolvedHook[] = [];
  for (const ref of ctx.project.config.hooks ?? []) {
    const { use, options } = normalizeUse(ref);
    const hook = ctx.project.registry.get("hook", use);
    // 登録されていないフックは、開いたときに警告を出している。
    if (!hook) continue;
    if (hook.events && !hook.events.includes(type)) continue;
    out.push({ hook, options });
  }
  return out;
}

const contextOf = (ctx: WsContext, options: Options): WorkflowContext => ({ options, host: ctx.project.host });

/**
 * 書き込みの前。どれかのフックが理由を返したら ApiError("blocked") で書き込みをやめる。
 * フックが例外を投げたときも書き込みをやめる（決まりを確かめられないまま書かない）。
 */
export async function runBefore(ctx: WsContext, event: WorkflowEvent): Promise<void> {
  if (isSystemWrite()) return;
  for (const { hook, options } of hooksFor(ctx, event.type)) {
    if (typeof hook.before !== "function") continue;
    let reason: string | void;
    try {
      reason = await hook.before(event, contextOf(ctx, options));
    } catch (err) {
      throw new ApiError("failed", `フック "${hook.id}" が失敗したため、書き込みをやめました: ${errorText(err)}`, { hook: hook.id });
    }
    if (typeof reason === "string" && reason !== "") throw new ApiError("blocked", reason, { hook: hook.id });
  }
}

/** フックの変更点を反映する関数（editing.ts の applyPatches。循環 import を避けるため引数で受け取る）。 */
export type ApplyPatches = (ctx: WsContext, patches: CellPatch[], why: { cause: "hook"; causeRef: string }) => Promise<{ patched: number; errors: string[] }>;

/**
 * 書き込みのあと。失敗しても書き込みは済んでいるので、警告にして続ける。
 * リソースのロックの外で呼ぶこと（返された変更点が同じリソースを書くことがある）。apply を渡さない呼び出し
 * （resource.write。ロックの中で呼ぶ）では、変更点は受け付けない。
 */
export async function runAfter(ctx: WsContext, event: WorkflowEvent, apply?: ApplyPatches): Promise<void> {
  if (isSystemWrite()) return;
  for (const { hook, options } of hooksFor(ctx, event.type)) {
    if (typeof hook.after !== "function") continue;
    try {
      const result = await hook.after(event, contextOf(ctx, options));
      const patches = result && Array.isArray(result.patches) ? result.patches : [];
      if (patches.length === 0) continue;
      if (!apply) {
        ctx.warn(`フック "${hook.id}" は ${event.type} の after で変更点（patches）を返しましたが、このできごとでは反映できません。`);
        continue;
      }
      const applied = await runAsSystem(() => apply(ctx, patches, { cause: "hook", causeRef: hook.id }));
      for (const e of applied.errors) ctx.warn(`フック "${hook.id}" の変更点を反映できませんでした: ${e}`);
    } catch (err) {
      ctx.warn(`フック "${hook.id}"（${event.type} の after）が失敗しました: ${errorText(err)}`);
    }
  }
}
