import net from "node:net";

/** OS に空きポートを選ばせる。選んだあと閉じるので、起動までの間に取られる可能性はごくわずかにある。 */
export function findFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", (err) => reject(new Error(`空きポートを探せませんでした（${host}）: ${err.message}`, { cause: err })));
    srv.listen(0, host, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("空きポートを取得できませんでした。"));
        return;
      }
      srv.close(() => resolve(addr.port));
    });
  });
}
