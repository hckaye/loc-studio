import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Web 側が書く最近のプロジェクトの一覧（<userData>/web-session.json）を読む。
 * 一覧はメニューの飾りなので、読めなければ空にする。ただし壊れていることは warn で知らせる。
 */
export function readRecentProjects(userDataDir: string, warn: (message: string) => void = () => {}): string[] {
  const file = path.join(userDataDir, "web-session.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") warn(`最近のプロジェクトの一覧を読めませんでした（${file}）: ${(err as Error).message}`);
    return [];
  }
  try {
    const parsed = JSON.parse(text) as { recentProjects?: unknown };
    return Array.isArray(parsed.recentProjects) ? parsed.recentProjects.filter((v): v is string => typeof v === "string") : [];
  } catch (err) {
    warn(`最近のプロジェクトの一覧が壊れています（${file}）: ${(err as Error).message}`);
    return [];
  }
}
