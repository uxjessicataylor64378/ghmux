#!/usr/bin/env node
/**
 * ghmux — ghmux 的 Agent 操作入口（hot-mcp 热加载架构）
 *
 * index.mjs = 稳定层：MCP stdio 协议 + 业务通道 + reload 本体——动这里需新会话
 * tools.mjs = 活跃层：全部业务工具——Agent 发现不顺手直接改，reload 即时生效
 *
 * 用法：claude mcp add ghmux -- node <本文件路径>
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "ghmux", version: "0.1.0" });

// ============ 业务通道（进程内直连形态） ============
// ghmux 无常驻业务进程：tools.mjs 直接 import CLI 的 src 模块（账户存储/限流网关/
// gh 通道全是纯 Node），ctx 只提供工具注册器。⚠️ src 的 cmd* 系列会 console.log +
// process.exit（CLI 语义），MCP 层一律不用——只用纯函数（store/gh 的底层），
// 输出与退出由 MCP 层自己管理。

// ============ 工具热加载 ============
// SDK 没有 server.removeTool（不存在的方法！）；同名重注册抛 "already registered"。
// 卸载方式：server.tool() 返回的句柄自带 .remove()——reload 先逐个句柄 remove
// 清空旧集再注册新集（cdp-mcp 实证，SDK 1.30/1.32 均有）。

const registeredTools = [];

function makeCtx() {
	return {
		tool: (n, d, schema, handler) => {
			const handle = server.tool(n, d, schema, handler);
			registeredTools.push(handle);
			return handle;
		},
	};
}

async function loadTools() {
	for (const t of registeredTools.splice(0)) {
		try {
			t.remove();
		} catch {
			/* 未注册过则忽略 */
		}
	}
	const toolsUrl = process.env.GHMUX_TOOLS
		? pathToFileURL(process.env.GHMUX_TOOLS).href
		: pathToFileURL(join(import.meta.dirname, "tools.mjs")).href;
	const mod = await import(`${toolsUrl}?t=${Date.now()}`); // query 穿透 import 缓存
	await mod.register(server, makeCtx());
	await server.sendToolListChanged(); // 广播，客户端下次 listTools 拿到新面
}

// reload 本体常驻稳定层（不进 registeredTools，永不被热替换掉）
// 注：句柄 .remove() 是同步方法，不 await
server.tool(
	"reload",
	"热加载 tools.mjs——本 MCP 全部工具实现都在该文件：使用中发现不顺手/缺能力，直接编辑 tools.mjs（约定见文件头），改完调本工具，同会话立即生效（广播 tools/list_changed）。加载失败保留旧工具集并返回错误详情；index.mjs 是稳定层，动它才需要新会话",
	{},
	async () => {
		try {
			await loadTools();
			return { content: [{ type: "text", text: `已重载 ${registeredTools.length} 个工具` }] };
		} catch (e) {
			return {
				content: [{ type: "text", text: `重载失败（旧工具集保留）: ${e.message}\n修复 tools.mjs 后再次 reload` }],
				isError: true,
			};
		}
	},
);

// 启动加载失败不炸 server：只挂 reload，修复文件后调 reload 恢复（自愈）
try {
	await loadTools();
} catch (e) {
	process.stderr.write(`ghmux tools 加载失败（仅 reload 可用）: ${e.message}\n`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
