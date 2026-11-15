/** キーごとに処理を 1 つずつ実行する（リソースごとの保存を直列にするため）。 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    // 待つものがなくなったら消す（キーが増え続けないように）。
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
