// plan 审查卡片：Markdown 渲染计划正文 + 批准/拒绝/批注操作。
// 批注/拒绝需附 note（server 对 reject/annotate 强制要求），批准后按钮区收起。

import { type ReactElement, useState } from "react";
import { Markdown } from "./Markdown.tsx";

interface PlanPanelProps {
	phase: "drafted" | "approved" | "denied" | "revision_exhausted";
	plan?: string;
	// 是否为当前待审批的 plan（pendingPlan 槽位指向本卡片）
	pending: boolean;
	onDecide: (
		decision: "approve" | "reject" | "annotate",
		note?: string,
	) => void;
}

const PHASE_LABEL: Record<PlanPanelProps["phase"], string> = {
	drafted: "待审批",
	approved: "已批准",
	denied: "已拒绝",
	revision_exhausted: "修订次数已尽",
};

export function PlanPanel({
	phase,
	plan,
	pending,
	onDecide,
}: PlanPanelProps): ReactElement {
	const [note, setNote] = useState("");
	const noteReady = note.trim() !== "";
	return (
		<div className="plan-card">
			<div className="plan-card-head">
				<span className="plan-card-title">执行计划</span>
				<span className={phase === "drafted" ? "badge badge-warn" : "badge"}>
					{PHASE_LABEL[phase]}
				</span>
			</div>
			{plan !== undefined && plan !== "" && (
				<div className="plan-card-body">
					<Markdown text={plan} />
				</div>
			)}
			{pending && (
				<div className="plan-card-actions">
					<textarea
						className="plan-card-note"
						placeholder="批注（拒绝/批注时必填）"
						value={note}
						onChange={(e) => {
							setNote(e.target.value);
						}}
					/>
					<div className="plan-card-buttons">
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => {
								onDecide("approve");
							}}
						>
							批准
						</button>
						<button
							type="button"
							className="btn"
							disabled={!noteReady}
							onClick={() => {
								onDecide("annotate", note.trim());
							}}
						>
							批注
						</button>
						<button
							type="button"
							className="btn btn-danger"
							disabled={!noteReady}
							onClick={() => {
								onDecide("reject", note.trim());
							}}
						>
							拒绝
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
