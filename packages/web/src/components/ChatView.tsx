// 中栏：对话流 + 输入区。
// transcript 按 reducer 投影渲染：user/assistant 气泡、工具卡片、plan 卡片、
// 审批痕迹、错误行；流式段跟随 delta；pendingApproval 内联审批条。
// 输入区：空闲发送 = 新 turn；运行中发送 = steer（标注「steer 注入」）+ 取消按钮。

import { type ReactElement, useEffect, useRef, useState } from "react";
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
				<div className="approval-audit">
					审批 · {entry.summary}
					{entry.decision !== undefined && (
						<span
							className={
								entry.decision === "approved"
									? "badge badge-ok"
									: "badge badge-error"
							}
						>
							{entry.decision === "approved" ? "已允许" : "已拒绝"}
						</span>
					)}
				</div>
			);
		case "error":
			return (
				<div className="error-line">
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

	const running = state.turn === "running";

	return (
		<main className="chat">
			<div className="chat-scroll" ref={scrollRef}>
				{!hasSession ? (
					<div className="chat-empty">从左侧选择一个会话，或新建一个开始</div>
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
							<MessageBubble variant="streaming" text={state.streaming.text} />
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
			{hasSession && (
				<form
					className="chat-input"
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					{running && <span className="steer-hint">steer 注入</span>}
					<input
						className="chat-input-field"
						placeholder={
							running
								? "输入以注入 steer（next-step 队列）"
								: "输入消息，Enter 发送"
						}
						value={draft}
						onChange={(e) => {
							setDraft(e.target.value);
						}}
					/>
					{running ? (
						<button
							type="button"
							className="btn btn-danger"
							onClick={() => {
								onCancel();
							}}
						>
							取消
						</button>
					) : (
						<button type="submit" className="btn btn-primary">
							发送
						</button>
					)}
				</form>
			)}
		</main>
	);
}
