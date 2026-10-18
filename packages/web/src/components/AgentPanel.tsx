// 右侧面板：agent 树 + 用量条。
// 树形：main 节点（main_agent.png）→ worker（运行中 work_agent_active.webp，
// 否则 work_agent.png）→ task（同理 task_agent_*），按 parentAgentId 挂接。
// 每节点：任务文本（截断）、tier 徽标、status 徽标（running 转圈动画）、当前工具。
// 图片加载失败回退纯色圆点（onError 隐藏 img）。

import { type ReactElement, useState } from "react";
import type { AgentNode, AgentStatus, UsageTotals } from "../state/reducer.ts";

interface AgentPanelProps {
	agents: AgentNode[];
	usage: UsageTotals;
	turn: "idle" | "running";
	// main agent 档位徽标：由 App 传入（web 创建会话时选择值）；
	// 非 web 创建的会话无从得知，App 侧回退 "high"
	mainTier: string;
	open: boolean;
	sessionName: string;
	onToggle: () => void;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// token 数紧凑格式：1234 → 1.2k
function compact(n: number): string {
	if (n >= 1000) {
		return `${(n / 1000).toFixed(1)}k`;
	}
	return String(n);
}

// 头像：加载失败回退为纯色圆点
function Avatar({ src, label }: { src: string; label: string }): ReactElement {
	const [broken, setBroken] = useState(false);
	if (broken) {
		return <span className="avatar avatar-fallback" aria-hidden="true" />;
	}
	return (
		<img
			className="avatar"
			src={src}
			alt={label}
			onError={() => {
				setBroken(true);
			}}
		/>
	);
}

function StatusBadge({ status }: { status: AgentStatus }): ReactElement {
	if (status === "running") {
		return (
			<span className="badge badge-running">
				<span className="spinner" aria-hidden="true" />
				running
			</span>
		);
	}
	if (status === "failed") {
		return <span className="badge badge-error">failed</span>;
	}
	return <span className="badge badge-ok">done</span>;
}

// worker/task 形象图按运行状态切换 active 版本
function nodeAvatarSrc(node: AgentNode): string {
	const active = node.status === "running";
	if (node.role === "task") {
		return active ? "/task_agent_active.webp" : "/task_agent.png";
	}
	return active ? "/work_agent_active.webp" : "/work_agent.png";
}

function AgentRow({ node }: { node: AgentNode }): ReactElement {
	return (
		<div className="agent-row">
			<Avatar src={nodeAvatarSrc(node)} label={node.role} />
			<div className="agent-row-body">
				<div className="agent-row-title" title={node.task}>
					{truncate(node.task, 36)}
				</div>
				<div className="agent-row-meta">
					<span className="badge">{node.tier}</span>
					<StatusBadge status={node.status} />
					{node.currentTool !== undefined && (
						<span className="agent-row-tool" title={node.currentTool}>
							{truncate(node.currentTool, 18)}
						</span>
					)}
				</div>
			</div>
		</div>
	);
}

// 按 parentAgentId 递归渲染子树（agents 数组只含 spawn 出的 worker/task）
function AgentTree({
	agents,
	parentId,
	depth,
}: {
	agents: AgentNode[];
	parentId: string;
	depth: number;
}): ReactElement {
	const children = agents.filter((a) => a.parentAgentId === parentId);
	return (
		<>
			{children.map((node) => (
				<div key={node.agentId} style={{ marginLeft: depth * 14 }}>
					<AgentRow node={node} />
					<AgentTree
						agents={agents}
						parentId={node.agentId}
						depth={depth + 1}
					/>
				</div>
			))}
		</>
	);
}

export function AgentPanel({
	agents,
	usage,
	turn,
	mainTier,
	open,
	sessionName,
	onToggle,
}: AgentPanelProps): ReactElement {
	if (!open) {
		return (
			<aside className="agent-panel agent-panel-collapsed">
				<button type="button" className="btn" onClick={onToggle}>
					⟨ 展开面板
				</button>
			</aside>
		);
	}
	return (
		<aside className="agent-panel">
			<div className="agent-panel-header">
				<img className="logo" src="/logo.png" alt="hotpot" />
				<span className="agent-panel-title" title={sessionName}>
					{truncate(sessionName, 24)}
				</span>
				<button type="button" className="btn btn-link" onClick={onToggle}>
					收起 ⟩
				</button>
			</div>
			<div className="agent-panel-body">
				<div className="agent-row agent-row-main">
					<Avatar src="/main_agent.png" label="main" />
					<div className="agent-row-body">
						<div className="agent-row-title">main agent</div>
						<div className="agent-row-meta">
							<span className="badge">{mainTier}</span>
							<StatusBadge status={turn === "running" ? "running" : "done"} />
						</div>
					</div>
				</div>
				<AgentTree agents={agents} parentId="main" depth={1} />
			</div>
			<div className="agent-panel-footer">
				<span className="agent-panel-footer-label">用量</span>
				<ul className="usage-list">
					{Object.entries(usage.byTier).map(([tier, bucket]) => (
						<li key={tier} className="usage-row">
							<span className="usage-tier">{tier}</span>
							<span>
								in {compact(bucket.input)} · out {compact(bucket.output)} ·{" "}
								{bucket.count} 次
							</span>
						</li>
					))}
					<li className="usage-row usage-row-total">
						<span className="usage-tier">total</span>
						<span>
							in {compact(usage.total.input)} · out{" "}
							{compact(usage.total.output)}
						</span>
					</li>
				</ul>
			</div>
		</aside>
	);
}
