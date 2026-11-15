// 外部のテキスト管理 API とタスク管理 API の代わりをする、依存なしの小さなサーバー。
// すべてメモリ上に持つ。実行: node examples/remote-project/mock-api/server.mjs [--port 4010]
// 環境変数 MOCK_API_TOKEN でトークンを変えられる（既定は "dev-token"）。
import http from "node:http";
import { pathToFileURL } from "node:url";

const seed = () => ({
  "quests/main": {
    folder: "quests",
    name: "メインクエスト",
    entries: [
      { key: "q1.title", texts: { ja: "旅立ちの朝", en: "Morning of Departure", ko: "여행의 아침" } },
      { key: "q1.body", texts: { ja: "村の外へ出よう。", en: "Let's head outside the village.", ko: "" } },
      { key: "q2.title", texts: { ja: "古い橋", en: "", ko: "" } },
    ],
  },
  "ui/common": {
    folder: "ui",
    name: "共通 UI",
    entries: [
      { key: "ok", texts: { ja: "決定", en: "OK", ko: "확인" } },
      { key: "cancel", texts: { ja: "キャンセル", en: "Cancel", ko: "취소" } },
    ],
  },
});

/** ポートを指定して起動する。port: 0 で空きポート。 */
export function startMockApi({ port = 4010, token = process.env.MOCK_API_TOKEN ?? "dev-token" } = {}) {
  let resources = seed();
  let etagSeq = 1;
  const etags = new Map();
  const etagOf = (id) => {
    if (!etags.has(id)) etags.set(id, `"r${etagSeq++}"`);
    return etags.get(id);
  };
  // 状態: キーは "resource\u0000entryKey\u0000columnId\u0000language"
  let statuses = new Map();
  // テスト用: 受けたリクエストの記録（"METHOD /path"）と、次の N 回だけ返す失敗。
  const requests = [];
  const failures = [];
  const statusKey = (c) => [c.resourceId, c.entryKey, c.columnId, c.language ?? ""].join("\u0000");

  const send = (res, code, body, headers = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(text);
  };
  const readJson = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : undefined;
  };

  const server = http.createServer(async (req, res) => {
    try {
      // 本物の API と同じく、すべてのリクエストでトークンを確かめる。
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      const m = req.method;
      if (p !== "/reset" && !p.startsWith("/_test/")) requests.push(`${m} ${p}`);
      const fail = failures.find((f) => f.method === m && p.startsWith(f.pathPrefix) && f.count > 0);
      if (fail) {
        fail.count--;
        return send(res, fail.status, { error: `injected ${fail.status}` });
      }

      if (m === "POST" && p === "/reset") {
        resources = seed();
        etags.clear();
        statuses = new Map();
        requests.length = 0;
        failures.length = 0;
        return send(res, 200, { ok: true });
      }
      if (m === "GET" && p === "/resources") {
        return send(res, 200, Object.entries(resources).map(([id, r]) => ({ id, name: r.name, folder: r.folder, etag: etagOf(id) })));
      }
      if (p.startsWith("/resources/")) {
        const id = decodeURIComponent(p.slice("/resources/".length));
        const r = resources[id];
        if (m === "GET") {
          if (!r) return send(res, 404, { error: "not found" });
          return send(res, 200, { entries: r.entries }, { etag: etagOf(id) });
        }
        if (m === "HEAD") {
          // 本文を返さずに版（ETag）だけを知らせる。
          res.writeHead(r ? 200 : 404, r ? { etag: etagOf(id) } : {});
          return res.end();
        }
        if (m === "PUT") {
          const ifMatch = req.headers["if-match"];
          if (ifMatch !== undefined && (!r || ifMatch !== etagOf(id))) return send(res, 412, { error: "etag mismatch" });
          const doc = await readJson(req);
          if (!doc || !Array.isArray(doc.entries)) return send(res, 400, { error: "entries が必要です" });
          const prev = r ?? { folder: id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "", name: id };
          resources[id] = { ...prev, entries: doc.entries };
          etags.set(id, `"r${etagSeq++}"`);
          return send(res, 200, { ok: true }, { etag: etagOf(id) });
        }
      }
      if (m === "GET" && p === "/status") {
        const resource = url.searchParams.get("resource");
        return send(res, 200, [...statuses.values()].filter((s) => resource === null || s.resourceId === resource));
      }
      if (m === "PUT" && p === "/status") {
        // 1 件でも版が合わなければ、何も書かずに 409 を返す。
        const writes = (await readJson(req)) ?? [];
        const conflicts = [];
        for (const w of writes) {
          const cur = statuses.get(statusKey(w));
          if (w.expectedVersion !== undefined && (cur?.version ?? 0) !== w.expectedVersion) conflicts.push({ cell: w, current: cur });
        }
        if (conflicts.length > 0) return send(res, 409, { conflicts });
        const out = writes.map((w) => {
          const cur = statuses.get(statusKey(w));
          const next = { ...w, version: (cur?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
          delete next.expectedVersion;
          statuses.set(statusKey(w), next);
          return next;
        });
        return send(res, 200, out);
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        /** 受けたリクエスト（"METHOD /path"）。/reset で空になる。 */
        requests,
        /** 次の count 回、method と pathPrefix に合うリクエストに status を返す。 */
        failNext: (method, pathPrefix, status, count = 1) => failures.push({ method, pathPrefix, status, count }),
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const i = process.argv.indexOf("--port");
  const port = i >= 0 ? Number(process.argv[i + 1]) : 4010;
  const api = await startMockApi({ port });
  console.log(`モック API: ${api.url}（トークン: 環境変数 MOCK_API_TOKEN、既定 dev-token）`);
}
