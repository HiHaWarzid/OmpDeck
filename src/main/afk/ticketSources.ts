/**
 * AFK 工单源：GitHub Issues（via gh CLI，ADR-0002）。
 * gh 由 git remote 自动推断仓库——所有命令都在目标项目 cwd 运行。
 * 本模块是纯函数薄封装，便于单测；错误统一 throw（Orchestrator 捕获后标 failed），
 * 错误消息含 stderr 归一化（参照 GitService.runGit），并区分「gh 未安装」与「未认证」。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** gh 网络操作默认超时（list/createPr 等大调用单独加长） */
const GH_TIMEOUT_MS = 30_000;

/** 待派发工单的归一化形状（从 gh issue list --json 提取） */
export type AfkTicket = {
	/** GitHub Issue 编号（ticketRef） */
	number: number;
	/** Issue title（brief goal 原样派发） */
	title: string;
	/** label 名列表（含 workflow:* 工作流提示标签） */
	labels: string[];
	/** assignee login 列表 */
	assignees: string[];
};

/**
 * gh 命令执行器：收敛超时/缓冲/stderr 错误归一化。
 * execFile 的 error.message 不含 stderr，而 gh 的失败原因在 stderr（认证/网络/权限）——
 * 统一并入错误消息；ENOENT（gh 未安装）单独归类给出安装指引。
 */
async function runGh(
	cwd: string,
	args: string[],
	options: { allowFailure?: boolean; timeout?: number } = {},
): Promise<string> {
	try {
		const { stdout } = await execFileAsync("gh", args, {
			cwd,
			timeout: options.timeout ?? GH_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
		});
		return stdout;
	} catch (error) {
		if (options.allowFailure) return "";
		const execError = error as { stderr?: string; code?: unknown };
		// gh 未安装：ENOENT 时 error.message 只有 "spawn gh ENOENT"，需要给用户可执行的指引
		if (execError.code === "ENOENT") {
			throw new Error("gh CLI 未安装或不在 PATH，请先安装 GitHub CLI（https://cli.github.com）后重试");
		}
		const detail = execError.stderr?.trim() || (error instanceof Error ? error.message : String(error));
		// gh 认证失败：exit code 4 或 stderr 提示 auth/401（gh 文档：4 = authentication required）
		const needsAuth =
			execError.code === 4 || /auth|401|not logged in|login required/i.test(detail);
		const hint = needsAuth ? "（请先运行 gh auth login 完成 GitHub 认证）" : "";
		throw new Error(`gh ${args[0] ?? "command"} failed: ${detail}${hint}`);
	}
}

/**
 * 列出目标仓库待派发的工单（Selection 规则，CONTEXT.md）：
 * `gh issue list --state open --label ready-for-agent`，在项目 cwd 运行。
 */
export async function listReadyForAgent(cwd: string): Promise<AfkTicket[]> {
	const stdout = await runGh(
		cwd,
		[
			"issue",
			"list",
			"--state",
			"open",
			"--label",
			"ready-for-agent",
			"--json",
			"number,title,labels,assignees",
		],
		{ timeout: 60_000 },
	);
	const raw = JSON.parse(stdout) as Array<{
		number: number;
		title?: string;
		labels?: Array<{ name?: string }>;
		assignees?: Array<{ login?: string }>;
	}>;
	return raw.map((item) => ({
		number: item.number,
		title: item.title ?? "",
		labels: (item.labels ?? []).map((label) => label.name ?? "").filter(Boolean),
		assignees: (item.assignees ?? []).map((assignee) => assignee.login ?? "").filter(Boolean),
	}));
}

/**
 * 读取工单 body（brief 原文）：issue list 不含 body，选中后按需单独取，
 * 避免对列表内每个工单都发一次 view。
 */
export async function getIssueBody(cwd: string, number: number): Promise<string> {
	const stdout = await runGh(cwd, ["issue", "view", String(number), "--json", "body"]);
	const parsed = JSON.parse(stdout) as { body?: string | null };
	return parsed.body ?? "";
}

/** 当前 gh 认证账户 login（AFK Identity = @me，CONTEXT.md；用于已认领过滤）。 */
export async function getCurrentUser(cwd: string): Promise<string> {
	const stdout = await runGh(cwd, ["api", "user", "--jq", ".login"]);
	const login = stdout.trim();
	if (!login) throw new Error("gh 未能解析当前用户");
	return login;
}

/** 认领工单（session's first write）：`gh issue edit {n} --add-assignee @me`。 */
export async function claim(cwd: string, number: number): Promise<void> {
	await runGh(cwd, ["issue", "edit", String(number), "--add-assignee", "@me"]);
}

/**
 * 完成回写（ADR-0004）：重标 ready-for-agent → ready-for-human + comment。
 * prUrl 存在时 comment 带 PR 链接；无 PR（无真实提交，ADR-0006）时 comment 说明原因。
 */
export async function completeIssue(cwd: string, number: number, prUrl?: string): Promise<void> {
	await runGh(cwd, [
		"issue",
		"edit",
		String(number),
		"--remove-label",
		"ready-for-agent",
		"--add-label",
		"ready-for-human",
	]);
	const comment = prUrl
		? `AFK 自动完成 #${number}，PR: ${prUrl}`
		: `AFK 自动完成 #${number}，但 agent 未产生真实提交，未开 PR。`;
	await runGh(cwd, ["issue", "comment", String(number), "--body", comment]);
}

/**
 * 失败回写（ADR-0005）：comment 附失败原因 + 重标 ready-for-agent → needs-info。
 * needs-info 保证 ticket 离开 ready-for-agent，不会被 AFK 循环重派（Retry 需人介入）。
 */
export async function failIssue(cwd: string, number: number, summary: string): Promise<void> {
	await runGh(cwd, ["issue", "comment", String(number), "--body", `AFK 任务失败：\n\n${summary}`]);
	await runGh(cwd, [
		"issue",
		"edit",
		String(number),
		"--remove-label",
		"ready-for-agent",
		"--add-label",
		"needs-info",
	]);
}

/**
 * 开 PR（ADR-0004）：base 固定 main（契约），head 为 afk 分支；返回 PR URL。
 * 分支必须先 push 到远程（Orchestrator 保证顺序：push → removeWithWip → createPr）。
 */
export async function createPr(
	cwd: string,
	branch: string,
	title: string,
	body: string,
): Promise<{ url: string }> {
	const stdout = await runGh(
		cwd,
		["pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", body, "--json", "url"],
		{ timeout: 60_000 },
	);
	const parsed = JSON.parse(stdout) as { url?: string };
	const url = parsed.url ?? "";
	if (!url) throw new Error("gh pr create 未返回 PR URL");
	return { url };
}
