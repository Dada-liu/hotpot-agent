// 中栏：对话流（窄列居中）+ 底部浮起输入卡片。
// transcript 按 reducer 投影渲染：user/assistant 消息、工具卡片、plan 卡片、审批痕迹、错误行；
// 流式段跟随 delta；pendingApproval 内联审批条。
// 输入：空闲发送 = 新 turn；运行中发送 = steer（橙色胶囊标注）+ 停止钮。
// Enter 发送，Shift+Enter 换行；IME 组合键入中 Enter 不触发（isComposing 守卫）。

import { Send, Square } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactElement,
	useEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
}): ReactElement {
	switch (entry.kind) {
		case "user":
			return <MessageBubble variant="user" text={entry.content} />;
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
	}
}

interface ChatViewProps {
	state: ChatState;
	hasSession: boolean;
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
	onSend,
	onCancel,
	onApproval,
	onPlanDecision,
}: ChatViewProps): ReactElement {
	const [draft, setDraft] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);

	// 新事件/流式增量到达时滚到底部（依赖即“活动计数”，effect 内无需读取）
	// biome-ignore lint/correctness/useExhaustiveDependencies: 滚动跟随活动计数，刻意不读具体值
	useEffect(() => {
		const el = scrollRef.current;
		if (el !== null) {
			el.scrollTop = el.scrollHeight;
		}
	}, [state.transcript.length, state.streaming]);

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

	const running = state.turn === "running";

	return (
		<main className="flex min-h-0 flex-1 flex-col">
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
					{!hasSession ? (
						<div className="py-24 text-center text-sm text-muted-foreground">
							从左侧选择一个会话，或新建一个开始
						</div>
					) : (
						<>
							{state.transcript.map((entry) => (
								<TranscriptItem
									key={entry.id}
									entry={entry}
									pendingPlan={state.pendingPlan}
									onPlanDecision={onPlanDecision}
								/>
							))}
							{state.streaming !== null && (
								<MessageBubble
									variant="streaming"
									text={state.streaming.text}
								/>
							)}
							{/* 仅 tool 型审批内联审批条；plan 型由 plan 卡片承担 */}
							{state.pendingApproval !== null &&
								state.pendingApproval.approvalType === "tool" && (
									<ApprovalPrompt
										summary={state.pendingApproval.summary}
										detail={state.pendingApproval.detail}
										onAnswer={onApproval}
									/>
								)}
						</>
					)}
				</div>
			</div>
			{hasSession && (
				<div className="px-4 pb-5 pt-2">
					<form
						className="relative mx-auto max-w-3xl"
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
						<div className="flex items-end gap-2 rounded-2xl border bg-background p-3 shadow-lg shadow-black/5">
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
								className="min-h-[38px] flex-1 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
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
				</div>
			)}
		</main>
	);
}
