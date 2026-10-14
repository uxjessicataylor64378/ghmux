// 冒烟：起 server 子进程走一遍 MCP 协议（initialize → tools/list → accounts/who 真实调用 + 双 reload）
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const p = spawn("node", [join(import.meta.dirname, "index.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
let nextId = 1;
p.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		const msg = JSON.parse(line);
		if (msg.id && pending.has(msg.id)) {
			pending.get(msg.id)(msg);
			pending.delete(msg.id);
		}
	}
});
p.stderr.on("data", (d) => process.stderr.write("[mcp] " + d));

const send = (method, params) =>
	new Promise((resolve) => {
		const id = nextId++;
		pending.set(id, resolve);
		p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	});

const init = await send("initialize", {
	protocolVersion: "2024-11-05",
	capabilities: {},
	clientInfo: { name: "smoke", version: "0" },
});
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
console.log("server:", init.result.serverInfo.name, init.result.serverInfo.version);

const tools = await send("tools/list", {});
console.log("tools:", tools.result.tools.map((t) => t.name).join(", "));

// 真实工具：accounts（读配置）
const acc = await send("tools/call", { name: "accounts", arguments: {} });
console.log("accounts →", acc.result.content[0].text.split("\n")[0]);

// 真实工具：who（临时 git 仓库，验证 cwd 感知）
const tmpRepo = mkdtempSync(join(tmpdir(), "ghmux-smoke-"));
const { execSync } = await import("node:child_process");
execSync("git init -q", { cwd: tmpRepo });
writeFileSync(join(tmpRepo, "a.txt"), "smoke");
const who = await send("tools/call", { name: "who", arguments: { cwd: tmpRepo } });
console.log("who →", who.result.content[0].text);

// 双 reload（热加载正确性：连续两次不炸）
for (let i = 1; i <= 2; i++) {
	const rl = await send("tools/call", { name: "reload", arguments: {} });
	console.log(`reload#${i} →`, rl.result.content[0].text);
}
p.kill();
process.exit(0);
