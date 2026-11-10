import { describe, expect, test, vi } from "vitest";
import { CommandError, type CommandRunner } from "../utils/CommandRunner";
import { RemoteAccessError, RemoteAccessManager } from "./RemoteAccessManager";

type RunCommand = CommandRunner["runCommand"];

function makeManager(
	runCommand: RunCommand,
	overrides: Partial<ConstructorParameters<typeof RemoteAccessManager>[0]> = {},
) {
	return new RemoteAccessManager({
		runCommand,
		getWebPort: () => 8765,
		isWebRunning: () => true,
		exists: () => true,
		platform: "linux",
		httpsPort: 8443,
		...overrides,
	});
}

function commandCalls(runCommand: RunCommand) {
	const calls = (runCommand as unknown as { mock: { calls: Array<[string, string[]]> } }).mock.calls;
	return calls.map(([bin, args]) => [bin, args] as [string, string[]]);
}

function runningStatus(dnsName = "dev.tailnet.ts.net.") {
	return JSON.stringify({ BackendState: "Running", Self: { DNSName: dnsName } });
}

describe("RemoteAccessManager", () => {
	test("starts Serve against loopback and derives the tailnet URL", async () => {
		const runCommand = vi.fn<RunCommand>(async (_bin, args) => {
			if (args[0] === "status") return { stdout: runningStatus() };
			if (args[0] === "serve" && args[1] === "status") return { stdout: "{}" };
			return { stdout: "" };
		});

		const status = await makeManager(runCommand).start();

		expect(status).toMatchObject({
			state: "running",
			enabled: true,
			url: "https://dev.tailnet.ts.net:8443",
			hostname: "dev.tailnet.ts.net",
			errorCode: null,
		});
		expect(commandCalls(runCommand)).toContainEqual([
			"/usr/bin/tailscale",
			["serve", "--bg", "--yes", "--https=8443", "http://127.0.0.1:8765"],
		]);
	});

	test("maps a missing CLI to not-installed without configuring Serve", async () => {
		const runCommand = vi.fn<RunCommand>(async () => {
			throw new CommandError("not-found", "spawn tailscale ENOENT");
		});

		const manager = makeManager(runCommand);
		await expect(manager.start()).rejects.toMatchObject({
			code: "not-installed",
		});
		expect(commandCalls(runCommand).every(([, args]) => args[0] === "status")).toBe(true);
		expect(manager.getStatus().installed).toBe(false);
	});

	test("maps a logged-out Tailscale backend to not-logged-in", async () => {
		const runCommand = vi.fn<RunCommand>(async (_bin, args) => {
			if (args[0] === "status") {
				return { stdout: JSON.stringify({ BackendState: "NeedsLogin", Self: null }) };
			}
			return { stdout: "{}" };
		});

		await expect(makeManager(runCommand).start()).rejects.toMatchObject({
			code: "not-logged-in",
		});
	});

	test("rejects an existing Serve handler on the same port for another target", async () => {
		const runCommand = vi.fn<RunCommand>(async (_bin, args) => {
			if (args[0] === "status") return { stdout: runningStatus() };
			if (args[0] === "serve" && args[1] === "status") {
				return {
					stdout: JSON.stringify({
						TCP: { "dev.tailnet.ts.net:8443": { HTTPS: true } },
						Web: {
							"dev.tailnet.ts.net:8443": {
								Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
							},
						},
					}),
				};
			}
			return { stdout: "" };
		});

		await expect(makeManager(runCommand).start()).rejects.toMatchObject({
			code: "port-conflict",
		});
		expect(
			commandCalls(runCommand).some(([, args]) => args[0] === "serve" && args.includes("--bg")),
		).toBe(false);
	});

	test("overwrites its own Serve target when the web port changes", async () => {
		let webPort = 8765;
		const runCommand = vi.fn<RunCommand>(async (_bin, args) => {
			if (args[0] === "status") return { stdout: runningStatus() };
			if (args[0] === "serve" && args[1] === "status") {
				return {
					stdout: JSON.stringify({
						Web: { Handlers: { "/": { Proxy: "http://127.0.0.1:8765" } } },
					}),
				};
			}
			return { stdout: "" };
		});
		const manager = makeManager(runCommand, { getWebPort: () => webPort });
		await manager.start();

		webPort = 9000;
		const status = await manager.start();

		expect(status.state).toBe("running");
		expect(commandCalls(runCommand)).toContainEqual([
			"/usr/bin/tailscale",
			["serve", "--bg", "--yes", "--https=8443", "http://127.0.0.1:9000"],
		]);
	});

	test("serializes stop behind an in-flight start", async () => {
		const startGate = Promise.withResolvers<void>();
		const runCommand = vi.fn<RunCommand>(async (_bin, args) => {
			if (args[0] === "status") return { stdout: runningStatus() };
			if (args[0] === "serve" && args[1] === "status") return { stdout: "{}" };
			if (args[0] === "serve" && args.includes("--bg")) {
				await startGate.promise;
				return { stdout: "" };
			}
			return { stdout: "" };
		});
		const manager = makeManager(runCommand);

		const startPromise = manager.start();
		await vi.waitFor(() => {
			expect(
				commandCalls(runCommand).some(([, args]) => args[0] === "serve" && args.includes("--bg")),
			).toBe(true);
		});
		const stopPromise = manager.stop();
		startGate.resolve();
		await startPromise;
		const status = await stopPromise;

		expect(status).toMatchObject({ state: "off", enabled: false, url: null });
		const serveCalls = commandCalls(runCommand).filter(([, args]) => args[0] === "serve");
		expect(serveCalls.at(-1)).toEqual(["/usr/bin/tailscale", ["serve", "--https=8443", "off"]]);
	});

	test("applies a final start after an interleaved stop", async () => {
		const startGate = Promise.withResolvers<void>();
		let bgCalls = 0;
		const runCommand = vi.fn<RunCommand>(async (_bin, args) => {
			if (args[0] === "status") return { stdout: runningStatus() };
			if (args[0] === "serve" && args[1] === "status") return { stdout: "{}" };
			if (args[0] === "serve" && args.includes("--bg")) {
				bgCalls += 1;
				if (bgCalls === 1) await startGate.promise;
				return { stdout: "" };
			}
			return { stdout: "" };
		});
		const manager = makeManager(runCommand);

		const firstStart = manager.start();
		await vi.waitFor(() => expect(bgCalls).toBe(1));
		const stop = manager.stop();
		const secondStart = manager.start();
		startGate.resolve();
		await firstStart;
		await stop;
		const status = await secondStart;

		expect(status.state).toBe("running");
		expect(bgCalls).toBe(2);
		const serveCalls = commandCalls(runCommand).filter(([, args]) => args[0] === "serve");
		expect(serveCalls.at(-1)?.[1]).toEqual([
			"serve",
			"--bg",
			"--yes",
			"--https=8443",
			"http://127.0.0.1:8765",
		]);
	});

	test("reconciles a stale Serve handler when remote access is disabled at startup", async () => {
		const runCommand = vi.fn<RunCommand>(async (_bin, args) => {
			if (args[0] === "serve" && args[1] === "status") {
				return {
					stdout: JSON.stringify({
						Web: { Handlers: { "/": { Proxy: "http://127.0.0.1:8765" } } },
					}),
				};
			}
			return { stdout: "" };
		});
		const manager = makeManager(runCommand);

		const status = await manager.applySettings({
			remoteAccessEnabled: false,
			webServiceEnabled: true,
		});

		expect(status.state).toBe("off");
		expect(commandCalls(runCommand)).toContainEqual([
			"/usr/bin/tailscale",
			["serve", "--https=8443", "off"],
		]);
	});

	test("throws when Serve removal fails so settings can roll back", async () => {
		const runCommand = vi.fn<RunCommand>(async (_bin, args) => {
			if (args[0] === "status") return { stdout: runningStatus() };
			if (args[0] === "serve" && args[1] === "status") return { stdout: "{}" };
			if (args[0] === "serve" && args.includes("off")) {
				throw new CommandError("command", "tailscale serve off failed");
			}
			return { stdout: "" };
		});
		const manager = makeManager(runCommand);
		await manager.start();

		await expect(manager.stop()).rejects.toMatchObject({ code: "start-failed" });
		expect(manager.getStatus()).toMatchObject({ state: "error", errorCode: "start-failed" });
	});

	test("removes its own handler on stop", async () => {
		const runCommand = vi.fn<RunCommand>(async (_bin, args) => {
			if (args[0] === "status") return { stdout: runningStatus() };
			if (args[0] === "serve" && args[1] === "status") {
				return { stdout: JSON.stringify({ Web: { Handlers: { "/": { Proxy: "http://127.0.0.1:8765" } } } }) };
			}
			return { stdout: "" };
		});
		const manager = makeManager(runCommand);
		await manager.start();

		const status = await manager.stop();

		expect(status).toMatchObject({ enabled: false, state: "off", url: null });
		expect(commandCalls(runCommand)).toContainEqual([
			"/usr/bin/tailscale",
			["serve", "--https=8443", "off"],
		]);
	});

	test("does not remove an unrelated Serve handler on stop", async () => {
		const runCommand = vi.fn<RunCommand>(async (_bin, args) => {
			if (args[0] === "serve" && args[1] === "status") {
				return {
					stdout: JSON.stringify({
						Web: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
					}),
				};
			}
			return { stdout: "{}" };
		});
		const manager = makeManager(runCommand);

		await manager.stop();

		expect(
			commandCalls(runCommand).some(([, args]) => args[0] === "serve" && args.includes("off")),
		).toBe(false);
	});

	test("fails closed when the web service is not running", async () => {
		const runCommand = vi.fn<RunCommand>(async () => ({ stdout: "{}" }));
		const manager = makeManager(runCommand, { isWebRunning: () => false });

		await expect(
			manager.applySettings({ remoteAccessEnabled: true, webServiceEnabled: true }),
		).rejects.toMatchObject({ code: "web-service-off" });
		expect(commandCalls(runCommand)).toHaveLength(0);
	});

	test("maps a Serve timeout to serve-not-enabled (tailnet feature disabled)", async () => {
		const runCommand = vi.fn<RunCommand>(async (_bin, args) => {
			if (args[0] === "status") return { stdout: runningStatus() };
			if (args[0] === "serve" && args[1] === "status") return { stdout: "{}" };
			throw new CommandError("timeout", "tailscale serve timed out");
		});
		const manager = makeManager(runCommand);

		await expect(manager.start()).rejects.toMatchObject({ code: "serve-not-enabled" });
		expect(manager.getStatus()).toMatchObject({
			enabled: false,
			state: "error",
			errorCode: "serve-not-enabled",
		});
	});

	test("maps a failed Serve command to start-failed and keeps error state", async () => {
		const runCommand = vi.fn<RunCommand>(async (_bin, args) => {
			if (args[0] === "status") return { stdout: runningStatus() };
			if (args[0] === "serve" && args[1] === "status") return { stdout: "{}" };
			throw new CommandError("command", "tailscale serve failed");
		});
		const manager = makeManager(runCommand);

		await expect(manager.start()).rejects.toBeInstanceOf(RemoteAccessError);
		expect(manager.getStatus()).toMatchObject({
			enabled: false,
			state: "error",
			errorCode: "start-failed",
			url: null,
		});
	});
});
