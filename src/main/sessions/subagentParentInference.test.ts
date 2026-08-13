import assert from "node:assert/strict";
import { test } from "vitest";

import { inferParentCandidatesFromPath } from "./subagentParentInference";

const WIN_ROOT = "c:/users/ethanzhang/.omp/agent/sessions";
const POSIX_ROOT = "/home/ethan/.omp/agent/sessions";

test("Windows 反斜杠路径能推断出父会话（回归：posix 误用曾导致恒空）", () => {
  // omp 布局：<stem>/<label>.jsonl → 父 = <stem>.jsonl
  const file =
    "C:\\Users\\EthanZhang\\.omp\\agent\\sessions\\--D--WorkSpace--\\2026-08-07T01-42-33-287Z_019fd9e2\\AgentManagerApi.jsonl";
  assert.deepEqual(inferParentCandidatesFromPath(file, WIN_ROOT), [
    "C:\\Users\\EthanZhang\\.omp\\agent\\sessions\\--D--WorkSpace--\\2026-08-07T01-42-33-287Z_019fd9e2.jsonl",
    "C:\\Users\\EthanZhang\\.omp\\agent\\sessions\\--D--WorkSpace--.jsonl",
  ]);
});

test("Windows 多级嵌套逐层产出候选，且分隔符与输入一致", () => {
  // pi-subagents 布局：<stem>/<run-id>/run-N/session.jsonl
  const file = "C:\\s\\--D--P--\\stem\\run-1\\run-N\\session.jsonl";
  assert.deepEqual(inferParentCandidatesFromPath(file, "c:/s"), [
    "C:\\s\\--D--P--\\stem\\run-1\\run-N.jsonl",
    "C:\\s\\--D--P--\\stem\\run-1.jsonl",
    "C:\\s\\--D--P--\\stem.jsonl",
    "C:\\s\\--D--P--.jsonl",
  ]);
});

test("WSL posix 路径照常推断", () => {
  const file = "/home/ethan/.omp/agent/sessions/--mnt-c--/stem/run-1/session.jsonl";
  assert.deepEqual(inferParentCandidatesFromPath(file, POSIX_ROOT), [
    "/home/ethan/.omp/agent/sessions/--mnt-c--/stem/run-1.jsonl",
    "/home/ethan/.omp/agent/sessions/--mnt-c--/stem.jsonl",
    "/home/ethan/.omp/agent/sessions/--mnt-c--.jsonl",
  ]);
});

test("顶层会话（文件直接在扫描根下）无候选", () => {
  assert.deepEqual(
    inferParentCandidatesFromPath("C:\\s\\top.jsonl", "c:/s"),
    [],
  );
  assert.deepEqual(
    inferParentCandidatesFromPath(`${POSIX_ROOT}/top.jsonl`, POSIX_ROOT),
    [],
  );
});

test("非 .jsonl 文件无候选", () => {
  assert.deepEqual(
    inferParentCandidatesFromPath("C:\\s\\stem\\note.md", "c:/s"),
    [],
  );
});

test("不超出扫描根：项目目录层级是最后一个候选层级", () => {
  const file =
    "C:\\Users\\EthanZhang\\.omp\\agent\\sessions\\proj\\stem\\run-1\\session.jsonl";
  assert.deepEqual(inferParentCandidatesFromPath(file, WIN_ROOT), [
    "C:\\Users\\EthanZhang\\.omp\\agent\\sessions\\proj\\stem\\run-1.jsonl",
    "C:\\Users\\EthanZhang\\.omp\\agent\\sessions\\proj\\stem.jsonl",
    "C:\\Users\\EthanZhang\\.omp\\agent\\sessions\\proj.jsonl",
  ]);
});
