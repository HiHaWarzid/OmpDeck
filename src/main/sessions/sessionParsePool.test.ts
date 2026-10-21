import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { expect, test } from "vitest";
import { SessionParsePool } from "./sessionParsePool";

class FakeWorker extends EventEmitter {
  terminated = 0;
  readonly requests: Array<{ id: number; filePath: string }> = [];

  unref(): void {}

  terminate(): Promise<number> {
    this.terminated += 1;
    return Promise.resolve(0);
  }

  postMessage(request: { id: number; filePath: string }): void {
    this.requests.push(request);
  }

  respond(requestId: number, filePath: string): void {
    this.emit("message", {
      id: requestId,
      ok: true,
      facts: {
        parsedLines: 1,
        malformedLines: 0,
        unreadable: false,
        rawEmpty: false,
        preview: filePath,
        firstUserText: "",
        firstAssistantText: "",
        messageCount: 0,
        source: "pi",
        hasSubagentChildMarker: false,
      },
    });
  }
}

test("取消正在解析的任务会终止 worker", async () => {
  const worker = new FakeWorker();
  const pool = new SessionParsePool({ createWorker: () => worker as unknown as Worker, size: 1 });
  const controller = new AbortController();

  const parsing = pool.parse("large.jsonl", controller.signal);
  expect(worker.requests).toHaveLength(1);
  controller.abort();

  await expect(parsing).rejects.toMatchObject({ name: "AbortError" });
  expect(worker.terminated).toBe(1);
  await pool.dispose();
});

test("取消排队任务后，先到的任务仍能完成且不会重复派发", async () => {
  const worker = new FakeWorker();
  const pool = new SessionParsePool({ createWorker: () => worker as unknown as Worker, size: 1 });

  const first = pool.parse("first.jsonl");
  const controller = new AbortController();
  const second = pool.parse("second.jsonl", controller.signal);
  controller.abort();

  await expect(second).rejects.toMatchObject({ name: "AbortError" });
  expect(worker.requests).toHaveLength(1);

  worker.respond(worker.requests[0].id, "first.jsonl");
  await expect(first).resolves.toMatchObject({ preview: "first.jsonl" });
  expect(worker.requests).toHaveLength(1);
  await pool.dispose();
});

test("worker 崩溃会拒绝当前任务，并在下一次请求时重建", async () => {
  const workers: FakeWorker[] = [];
  const pool = new SessionParsePool({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    size: 1,
  });

  const first = pool.parse("first.jsonl");
  workers[0].emit("error", new Error("boom"));
  await expect(first).rejects.toThrow("boom");

  const second = pool.parse("second.jsonl");
  expect(workers).toHaveLength(2);
  workers[1].respond(workers[1].requests[0].id, "second.jsonl");
  await expect(second).resolves.toMatchObject({ preview: "second.jsonl" });
  await pool.dispose();
});
