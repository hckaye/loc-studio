#!/usr/bin/env node
import { suppressSqliteWarning } from "./warnings.js";

// node:sqlite は import 時に警告を出すので、フィルタを先に入れてから動的に読み込む。
suppressSqliteWarning();
const { run } = await import("./commands.js");

const code = await run(process.argv.slice(2), {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  env: process.env,
  cwd: process.cwd(),
  stdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString("utf8");
  },
});
process.exitCode = code;
