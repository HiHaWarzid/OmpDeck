import type { Worker } from "node:worker_threads";
import type { SessionSummaryFacts } from "./sessionSummaryFacts";
import type { SessionParseRequest, SessionParseResponse } from "./sessionParseProtocol";

interface ParseJob {
  id: number;
  filePath: string;
  signal?: AbortSignal;
  resolve: (facts: SessionSummaryFacts) => void;
  reject: (error: Error) => void;
  settled: boolean;
  onAbort?: () => void;
}

interface WorkerSlot {
  worker: Worker;
  current?: ParseJob;
}

export interface SessionParsePoolOptions {
  /** 测试可注入假 worker；生产由 sessionWorkerFactory 提供 electron-vite 的 ?nodeWorker 包装。 */
  createWorker: () => Worker;
  /** 并发 worker 数。解析是 CPU 密集任务，默认 2，避免和主进程抢满核心。 */
  size?: number;
}

/**
 * 会话摘要解析 worker 池。
 *
 * 设计约束：
 * - 懒启动：首次需要解析大会话时才创建 worker，普通小会话扫描不受启动成本影响。
 * - 每 worker 同时只处理一个请求；结果只回传摘要事实，不回传整份条目。
 * - AbortSignal 取消排队任务；正在执行的任务通过 terminate 该 worker 取消，
 *   避免已经放弃的扫描继续占满 CPU。
 * - worker 崩溃/退出时仅让当前任务失败，下一次请求会重新创建 worker。
 */
export class SessionParsePool {
  private readonly size: number;
  private readonly slots = new Set<WorkerSlot>();
  private readonly idle: WorkerSlot[] = [];
  private readonly queue: ParseJob[] = [];
  private nextId = 1;
  private disposed = false;

  constructor(private readonly options: SessionParsePoolOptions) {
    this.size = Math.max(1, options.size ?? 2);
  }

  parse(filePath: string, signal?: AbortSignal): Promise<SessionSummaryFacts> {
    if (this.disposed) return Promise.reject(new Error("session parse pool is disposed"));
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise<SessionSummaryFacts>((resolve, reject) => {
      const job: ParseJob = {
        id: this.nextId++,
        filePath,
        signal,
        resolve,
        reject,
        settled: false,
      };
      if (signal) {
        job.onAbort = () => this.cancel(job);
        signal.addEventListener("abort", job.onAbort, { once: true });
      }
      this.queue.push(job);
      this.pump();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error("session parse pool is disposed");
    for (const job of this.queue.splice(0)) this.rejectJob(job, error);
    const terminations: Promise<number>[] = [];
    for (const slot of this.slots) {
      if (slot.current) this.rejectJob(slot.current, error);
      terminations.push(slot.worker.terminate().catch(() => 0));
    }
    this.slots.clear();
    this.idle.length = 0;
    await Promise.all(terminations);
  }

  private pump(): void {
    if (this.disposed) return;
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (job.settled) continue;
      if (job.signal?.aborted) {
        this.rejectJob(job, abortError());
        continue;
      }

      const slot = this.idle.pop() ?? (this.slots.size < this.size ? this.spawn() : undefined);
      if (!slot) {
        // 所有 worker 都在忙：放回队首，等任一 worker 空闲后再派发。
        this.queue.unshift(job);
        return;
      }
      this.dispatch(slot, job);
    }
  }

  private spawn(): WorkerSlot {
    const worker = this.options.createWorker();
    const slot: WorkerSlot = { worker };
    // 池不应阻止应用退出；SessionScanner.close() 会显式 dispose。
    worker.unref();
    worker.on("message", (response: SessionParseResponse) => this.onMessage(slot, response));
    worker.on("error", (error) => this.failSlot(slot, error));
    worker.on("exit", (code) => {
      if (!this.slots.has(slot)) return;
      this.failSlot(slot, new Error(`session parse worker exited with code ${code}`));
    });
    this.slots.add(slot);
    return slot;
  }

  private dispatch(slot: WorkerSlot, job: ParseJob): void {
    slot.current = job;
    const request: SessionParseRequest = { id: job.id, filePath: job.filePath };
    try {
      slot.worker.postMessage(request);
    } catch (error) {
      slot.current = undefined;
      this.rejectJob(job, asError(error));
      this.failSlot(slot, asError(error));
    }
  }

  private onMessage(slot: WorkerSlot, response: SessionParseResponse): void {
    const job = slot.current;
    if (!job || job.id !== response.id) return;
    slot.current = undefined;

    if (response.ok) this.resolveJob(job, response.facts);
    else this.rejectJob(job, new Error(response.error));

    if (this.disposed) {
      slot.worker.terminate().catch(() => 0);
      return;
    }
    this.idle.push(slot);
    this.pump();
  }

  private failSlot(slot: WorkerSlot, error: Error): void {
    if (!this.slots.has(slot)) return;
    this.slots.delete(slot);
    const idleIndex = this.idle.indexOf(slot);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);

    const job = slot.current;
    slot.current = undefined;
    if (job) this.rejectJob(job, error);
    if (!this.disposed) this.pump();
  }

  private cancel(job: ParseJob): void {
    if (job.settled) return;
    const queuedIndex = this.queue.indexOf(job);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.rejectJob(job, abortError());
      return;
    }

    for (const slot of this.slots) {
      if (slot.current !== job) continue;
      // 解析已经无法从 worker 内部打断：终止该 worker，下一次请求按需重建。
      slot.current = undefined;
      this.slots.delete(slot);
      const idleIndex = this.idle.indexOf(slot);
      if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
      void slot.worker.terminate().catch(() => 0);
      this.rejectJob(job, abortError());
      if (!this.disposed) this.pump();
      return;
    }
    this.rejectJob(job, abortError());
  }

  private resolveJob(job: ParseJob, facts: SessionSummaryFacts): void {
    if (job.settled) return;
    job.settled = true;
    this.cleanup(job);
    job.resolve(facts);
  }

  private rejectJob(job: ParseJob, error: Error): void {
    if (job.settled) return;
    job.settled = true;
    this.cleanup(job);
    job.reject(error);
  }

  private cleanup(job: ParseJob): void {
    if (job.signal && job.onAbort) {
      job.signal.removeEventListener("abort", job.onAbort);
    }
  }
}

function abortError(): Error {
  const error = new Error("session parse aborted");
  error.name = "AbortError";
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
