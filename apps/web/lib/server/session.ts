import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dataDir } from "./host";

/* 最近開いたプロジェクトの一覧。この PC だけの情報なので、アプリデータのフォルダの小さな JSON に置く。 */

const MAX_RECENT = 12;

async function sessionFile(): Promise<string> {
  return path.join(await dataDir(), "web-session.json");
}

interface SessionData {
  recentProjects: string[];
}

export async function readSession(): Promise<SessionData> {
  const file = await sessionFile();
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { recentProjects: [] };
    throw new Error(`最近のプロジェクトの一覧を読めませんでした（${file}）: ${(err as Error).message}`, { cause: err });
  }
  try {
    const parsed = JSON.parse(text) as Partial<SessionData>;
    const list = Array.isArray(parsed.recentProjects) ? parsed.recentProjects.filter((v) => typeof v === "string") : [];
    return { recentProjects: list };
  } catch {
    // 壊れていたら作り直す（一覧が消えるだけで、プロジェクトには影響しない）
    return { recentProjects: [] };
  }
}

export async function rememberProject(root: string): Promise<string[]> {
  const current = await readSession();
  const list = [root, ...current.recentProjects.filter((p) => p !== root)].slice(0, MAX_RECENT);
  const file = await sessionFile();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ recentProjects: list }, null, 2) + os.EOL, "utf8");
  await rename(tmp, file);
  return list;
}

/** Electron の殻から起動されたか（殻が環境変数で知らせる）。 */
export function isDesktop(): boolean {
  return process.env["LOC_STUDIO_DESKTOP"] === "1";
}
