// 中栏：对话流按回合分组——右侧用户气泡，左侧 main_agent 头像栏（思考/工具过程 + 最终回答）；
// welcome 态（待创建会话）时 logo 与输入框居中。
// 过程区（思考文本 + 工具卡片）只在进行中展开；最终回答存在或开始流式生成时默认折叠，可手动展开。
// 输入：空闲发送 = 新 turn；运行中发送 = steer（橙色胶囊标注）+ 停止钮。
// Enter 发送，Shift+Enter 换行；IME 组合键入中 Enter 不触发（isComposing 守卫）。

import { ChevronDown, ChevronRight, Send, Square } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactElement,
	useEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
	findFinalAnswer,
	groupTranscript,
	isProcessItem,
	type TurnGroup,
} from "../lib/turn-groups.ts";
import type { ContentBlock } from "../protocol.ts";
import type { ChatState, TranscriptEntry } from "../state/reducer.ts";
import { ApprovalPrompt } from "./ApprovalPrompt.tsx";
import { MessageBubble } from "./MessageBubble.tsx";
import { PlanPanel } from "./PlanPanel.tsx";
import { ToolCallCard } from "./ToolCallCard.tsx";

// assistant 消息的文本块拼接（tool_call 块不渲染文本）
function textOf(content: ContentBlock[]): string {
	return content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n\n");
}

function TranscriptItem({
	entry,
	pendingPlan,
	onPlanDecision,
}: {
	entry: TranscriptEntry;
	pendingPlan: ChatState["pendingPlan"];
	onPlanDecision: (
		decision: "approve" | "reject" | "annotate",
		note?: string,
	) => void;
}): ReactElement | null {
	switch (entry.kind) {
		case "assistant":
			return <MessageBubble variant="assistant" text={textOf(entry.content)} />;
		case "tool":
			return (
				<ToolCallCard
					name={entry.name}
					input={entry.input}
					result={entry.result}
				/>
			);
		case "plan":
			return (
				<PlanPanel
					phase={entry.phase}
					plan={entry.plan}
					pending={pendingPlan?.entryId === entry.id}
					onDecide={onPlanDecision}
				/>
			);
		case "approval":
			// 审计痕迹行（待处理的由 ApprovalPrompt 内联呈现）
			return (
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					审批 · {entry.summary}
					{entry.decision !== undefined && (
						<span
							className={
								entry.decision === "approved"
									? "font-medium text-foreground"
									: "font-medium text-destructive"
							}
						>
							{entry.decision === "approved" ? "已允许" : "已拒绝"}
						</span>
					)}
				</div>
			);
		case "error":
			return (
				<div className="font-mono text-xs text-destructive">
					[{entry.code}] {entry.message}
				</div>
			);
		default:
			// user 条目在回合组头部单独渲染
			return null;
	}
}

// 输入卡片：welcome 态与对话底部共用；空闲发送 = 新 turn，运行中发送 = steer + 停止钮
function Composer({
	running,
	onSend,
	onCancel,
}: {
	running: boolean;
	onSend: (content: string) => void;
	onCancel: () => void;
}): ReactElement {
	const [draft, setDraft] = useState("");

	const submit = (): void => {
		const content = draft.trim();
		if (content === "") {
			return;
		}
		setDraft("");
		onSend(content);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		// isComposing 守卫：中文输入法组字中的 Enter 用于选词，不能发送
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			submit();
		}
	};

	return (
		<form
			className="relative w-full"
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			{running && (
				<span className="absolute -top-3 left-4 rounded-full bg-brand px-2.5 py-0.5 text-[11px] font-medium text-white shadow-sm">
					steer 注入
				</span>
			)}
			<div className="flex items-end gap-2 rounded-2xl border border-border-strong bg-background p-3 shadow-lg shadow-black/5">
				<Textarea
					value={draft}
					onChange={(e) => {
						setDraft(e.target.value);
					}}
					onKeyDown={onKeyDown}
					placeholder={
						running
							? "输入以注入 steer（next-step 队列）"
							: "输入消息，Enter 发送"
					}
					rows={1}
					className="min-h-[76px] flex-1 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
				/>
				{running ? (
					<Button
						type="button"
						variant="destructive"
						size="icon"
						className="rounded-full"
						onClick={() => {
							onCancel();
						}}
						aria-label="取消"
					>
						<Square className="size-4" />
					</Button>
				) : (
					<Button
						type="submit"
						size="icon"
						className="rounded-full"
						disabled={draft.trim() === ""}
						aria-label="发送"
					>
						<Send className="size-4" />
					</Button>
				)}
			</div>
		</form>
	);
}

// 单个回合组：右侧用户气泡 + 左侧头像栏（过程区 + 常驻条目 + 最终回答/流式段）
function TurnView({
	group,
	isLast,
	streaming,
	pendingApproval,
	pendingPlan,
	onApproval,
	onPlanDecision,
}: {
	group: TurnGroup;
	isLast: boolean;
	streaming: ChatState["streaming"];
	pendingApproval: ChatState["pendingApproval"];
	pendingPlan: ChatState["pendingPlan"];
	onApproval: (decision: "allow" | "deny") => void;
	onPlanDecision: (
		decision: "approve" | "reject" | "annotate",
		note?: string,
	) => void;
}): ReactElement {
	const finalEntry = findFinalAnswer(group.items);
	// 过程区 = 思考（assistant 文本）+ 工具卡片；plan/approval/error 常驻不参与折叠
	const processItems = group.items.filter(
		(e) => e !== finalEntry && isProcessItem(e),
	);
	const standingItems = group.items.filter(
		(e) => e !== finalEntry && !isProcessItem(e),
	);
	// 流式段只属于最后一个回合组，且视为最终回答生成中
	const streamingHere =
		isLast && streaming !== null && streaming.agentId === "main";
	// 最终回答已落库或正在生成时，过程区默认折叠；用户可手动展开/收起
	const defaultCollapsed = finalEntry !== undefined || streamingHere;
	const [override, setOverride] = useState<boolean | null>(null);
	const expanded = override !== null ? override : !defaultCollapsed;

	return (
		<div className="flex flex-col gap-4">
			{group.user !== null && (
				<MessageBubble variant="user" text={group.user.content} />
			)}
			{(processItems.length > 0 ||
				standingItems.length > 0 ||
				finalEntry !== undefined ||
				streamingHere) && (
				<div className="flex items-start gap-3">
					<img
						src="/main_agent.png"
						alt="main agent"
						className="mt-0.5 size-9 shrink-0 rounded-full bg-secondary object-cover"
					/>
					<div className="flex min-w-0 flex-1 flex-col gap-3">
						{processItems.length > 0 && (
							<div>
								<button
									type="button"
									className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
									onClick={() => {
										setOverride(!expanded);
									}}
								>
									{expanded ? (
										<ChevronDown className="size-3" />
									) : (
										<ChevronRight className="size-3" />
									)}
									思考与工具过程（{processItems.length}）
								</button>
								{expanded && (
									<div className="mt-2 flex flex-col gap-3">
										{processItems.map((entry) => (
											<TranscriptItem
												key={entry.id}
												entry={entry}
												pendingPlan={pendingPlan}
												onPlanDecision={onPlanDecision}
											/>
										))}
									</div>
								)}
							</div>
						)}
						{standingItems.map((entry) => (
							<TranscriptItem
								key={entry.id}
								entry={entry}
								pendingPlan={pendingPlan}
								onPlanDecision={onPlanDecision}
							/>
						))}
						{finalEntry !== undefined && (
							<TranscriptItem
								entry={finalEntry}
								pendingPlan={pendingPlan}
								onPlanDecision={onPlanDecision}
							/>
						)}
						{streamingHere && (
							<MessageBubble variant="streaming" text={streaming?.text ?? ""} />
						)}
						{/* 仅 tool 型审批内联审批条；plan 型由 plan 卡片承担 */}
						{isLast &&
							pendingApproval !== null &&
							pendingApproval.approvalType === "tool" && (
								<ApprovalPrompt
									summary={pendingApproval.summary}
									detail={pendingApproval.detail}
									onAnswer={onApproval}
								/>
							)}
					</div>
				</div>
			)}
		</div>
	);
}

interface ChatViewProps {
	state: ChatState;
	hasSession: boolean;
	welcome: boolean;
	onSend: (content: string) => void;
	onCancel: () => void;
	onApproval: (decision: "allow" | "deny") => void;
	onPlanDecision: (
		decision: "approve" | "reject" | "annotate",
		note?: string,
	) => void;
}

export function ChatView({
	state,
	hasSession,
	welcome,
	onSend,
	onCancel,
	onApproval,
	onPlanDecision,
}: ChatViewProps): ReactElement {
	const scrollRef = useRef<HTMLDivElement>(null);

	// 新事件/流式增量到达时滚到底部（依赖即“活动计数”，effect 内无需读取）
	// biome-ignore lint/correctness/useExhaustiveDependencies: 滚动跟随活动计数，刻意不读具体值
	useEffect(() => {
		const el = scrollRef.current;
		if (el !== null) {
			el.scrollTop = el.scrollHeight;
		}
	}, [state.transcript.length, state.streaming]);

	// welcome 态（点“新建会话”后、首条消息前）：logo 与输入框垂直居中，不在列表新增会话
	if (welcome) {
		return (
			<main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-4">
				<div className="flex flex-col items-center gap-3">
					<img
						src="/logo.png"
						alt="hotpot"
						className="h-14 w-14 rounded-2xl object-contain"
					/>
					<span className="text-lg font-semibold tracking-tight">
						有什么可以帮你？
					</span>
				</div>
				<div className="w-full max-w-2xl">
					<Composer running={false} onSend={onSend} onCancel={onCancel} />
				</div>
			</main>
		);
	}

	const groups = groupTranscript(state.transcript);
	const lastIndex = groups.length - 1;

	return (
		<main className="flex min-h-0 flex-1 flex-col">
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
					{groups.map((group, i) => (
						<TurnView
							key={group.id}
							group={group}
							isLast={i === lastIndex}
							streaming={state.streaming}
							pendingApproval={state.pendingApproval}
							pendingPlan={state.pendingPlan}
							onApproval={onApproval}
							onPlanDecision={onPlanDecision}
						/>
					))}
				</div>
			</div>
			{hasSession && (
				<div className="px-4 pb-10 pt-2">
					<div className="mx-auto max-w-3xl">
						<Composer
							running={state.turn === "running"}
							onSend={onSend}
							onCancel={onCancel}
						/>
					</div>
				</div>
			)}
		</main>
	);
}
