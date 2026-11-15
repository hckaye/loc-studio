/**
 * テスト用の補助（公開 API ではない。index.ts からは出さない）。
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * この環境でシンボリックリンクを作れるか。Windows では、開発者モードか管理者の権限がないと作れない。
 * シンボリックリンクを使うテストは `it.skipIf(!canSymlink)` で飛ばす。こうすると結果に「飛ばした」と出る
 * （テストの中で黙って return すると、何も確かめていないのに通ったように見えてしまう）。
 */
export const canSymlink: boolean = (() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loc-symlink-"));
  try {
    writeFileSync(path.join(dir, "target"), "x");
    symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
