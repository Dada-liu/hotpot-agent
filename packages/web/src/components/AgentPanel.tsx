// 右侧面板：main / worker / task 全部卡片化呈现（可视化重点）。
// 卡片 = 状态感头像（运行中切 *_active.webp 动图）+ 任务文本 + tier/状态徽标 + 当前工具；
// 运行中卡片橙边高亮；worker/task 层级树用左边线 + 缩进表达；底部用量卡片按 tier 分组。
// 收起时退化为右下角浮动圆钮（不挤占布局）。

import { Check, Loader2, PanelRightOpen, Wrench, X } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
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

// 头像：加载失败回退为首字母圆点
function Avatar({
	src,
	label,
	className,
}: {
	src: string;
	label: string;
	className?: string;
}): ReactElement {
	const [broken, setBroken] = useState(false);
	if (broken) {
		return (
			<span
				className={cn(
					"flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-muted-foreground",
					className,
				)}
				aria-hidden="true"
			>
				{label.slice(0, 1).toUpperCase()}
			</span>
		);
	}
	return (
		<img
			className={cn(
				"size-9 shrink-0 rounded-full bg-secondary object-cover",
				className,
			)}
			src={src}
			alt={label}
			onError={() => {
				setBroken(true);
			}}
		/>
	);
}

// 状态徽标：running 橙色转圈 / done 黑勾 / failed 深橙
function StatusBadge({ status }: { status: AgentStatus }): ReactElement {
	if (status === "running") {
		return (
			<Badge
				variant="outline"
				className="gap-1 border-brand/30 bg-brand-soft text-[11px] text-brand"
			>
				<Loader2 className="size-3 animate-spin" />
				running
			</Badge>
		);
	}
	if (status === "failed") {
		return (
			<Badge variant="destructive" className="text-[11px]">
				failed
			</Badge>
		);
	}
	return (
		<Badge variant="secondary" className="gap-1 text-[11px]">
			<Check className="size-3" />
			done
		</Badge>
	);
}

// worker/task 形象图按运行状态切换 active 版本
function nodeAvatarSrc(node: AgentNode): string {
	const active = node.status === "running";
	if (node.role === "task") {
		return active ? "/task_agent_active.webp" : "/task_agent.png";
	}
	return active ? "/work_agent_active.webp" : "/work_agent.png";
}

// 单个 worker / task 卡片
function AgentCard({ node }: { node: AgentNode }): ReactElement {
	const running = node.status === "running";
	return (
		<Card
			className={cn(
				"gap-2 rounded-xl p-3 transition-shadow",
				running && "border-brand/50 shadow-sm",
			)}
		>
			<div className="flex items-start gap-2.5">
				<Avatar
					src={nodeAvatarSrc(node)}
					label={node.role}
					className={cn(running && "ring-2 ring-brand/40")}
				/>
				<div className="min-w-0 flex-1">
					<div
						className="truncate text-[13px] font-medium leading-snug"
						title={node.task}
					>
						{truncate(node.task, 42)}
					</div>
					<div className="mt-1 flex flex-wrap items-center gap-1.5">
						<Badge
							variant="outline"
							className="text-[10px] font-normal text-muted-foreground"
						>
							{node.tier}
						</Badge>
						<StatusBadge status={node.status} />
					</div>
				</div>
			</div>
			{node.currentTool !== undefined && (
				<div className="flex items-center gap-1.5 border-t border-dashed pt-1.5 text-[11px] text-muted-foreground">
					<Wrench className="size-3 shrink-0" />
					<span className="truncate font-mono" title={node.currentTool}>
						{truncate(node.currentTool, 30)}
					</span>
				</div>
			)}
		</Card>
	);
}

// 按 parentAgentId 递归渲染子树（agents 数组只含 spawn 出的 worker/task）；
// 层级用左边线 + 缩进可视化
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
				<div
					key={node.agentId}
					className={cn(
						"flex flex-col gap-2 border-l-2 border-border/70 pl-2",
						depth > 1 && "ml-1",
					)}
				>
					<AgentCard node={node} />
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
			<Button
				type="button"
				size="icon"
				className="fixed bottom-6 right-6 z-50 size-11 rounded-full shadow-lg"
				onClick={onToggle}
				aria-label="展开面板"
			>
				<PanelRightOpen className="size-4" />
			</Button>
		);
	}
	const mainRunning = turn === "running";
	return (
		<aside className="flex h-full w-80 shrink-0 flex-col border-l bg-secondary/40">
			<div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
				<img
					src="/logo.png"
					alt="hotpot"
					className="size-6 rounded-md object-contain"
				/>
				<span
					className="min-w-0 flex-1 truncate text-sm font-medium"
					title={sessionName}
				>
					{truncate(sessionName, 22)}
				</span>
				<Button
					variant="ghost"
					size="icon"
					className="size-8"
					onClick={onToggle}
					aria-label="收起面板"
				>
					<X className="size-4" />
				</Button>
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<div className="flex flex-col gap-2.5 p-3">
					{/* main agent 大卡 */}
					<Card
						className={cn(
							"gap-2.5 rounded-xl p-3 transition-shadow",
							mainRunning && "border-brand/50 shadow-sm",
						)}
					>
						<div className="flex items-center gap-2.5">
							<Avatar
								src="/main_agent.png"
								label="main"
								className={cn(mainRunning && "ring-2 ring-brand/40")}
							/>
							<div className="min-w-0 flex-1">
								<div className="text-[13px] font-semibold">main agent</div>
								<div className="mt-1 flex items-center gap-1.5">
									<Badge
										variant="outline"
										className="text-[10px] font-normal text-muted-foreground"
									>
										{mainTier}
									</Badge>
									<StatusBadge status={mainRunning ? "running" : "done"} />
								</div>
							</div>
						</div>
					</Card>
					{agents.length > 0 ? (
						<AgentTree agents={agents} parentId="main" depth={1} />
					) : (
						<div className="py-4 text-center text-xs text-muted-foreground">
							spawn worker 后此处展示任务卡片
						</div>
					)}
				</div>
			</ScrollArea>
			{/* 用量卡片：按 tier 分组 */}
			<div className="shrink-0 p-3 pt-0">
				<Card className="gap-1.5 rounded-xl p-3 text-xs">
					<div className="text-[11px] font-medium text-muted-foreground">
						用量
					</div>
					{Object.entries(usage.byTier).map(([tier, bucket]) => (
						<div key={tier} className="flex items-center justify-between gap-2">
							<span className="font-mono text-[11px] text-muted-foreground">
								{tier}
							</span>
							<span className="font-mono text-[11px]">
								in {compact(bucket.input)} · out {compact(bucket.output)} ·{" "}
								{bucket.count} 次
							</span>
						</div>
					))}
					<div className="mt-1 flex items-center justify-between gap-2 border-t border-dashed pt-1.5">
						<span className="font-mono text-[11px] font-medium">total</span>
						<span className="font-mono text-[11px] font-medium">
							in {compact(usage.total.input)} · out{" "}
							{compact(usage.total.output)}
						</span>
					</div>
				</Card>
			</div>
		</aside>
	);
}
