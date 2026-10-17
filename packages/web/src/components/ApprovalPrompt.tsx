// 审批条：pendingApproval 时内联渲染。summary + 可展开 detail + 允许/拒绝按钮。
// 注意：approvalType "plan" 的审批由 plan 卡片承担（与 plan(drafted) 同源），
// 本组件只处理 tool 型审批。

import { type ReactElement, useState } from "react";

interface ApprovalPromptProps {
	summary: string;
	detail?: string;
	onAnswer: (decision: "allow" | "deny") => void;
}

export function ApprovalPrompt({
	summary,
	detail,
	onAnswer,
}: ApprovalPromptProps): ReactElement {
	const [expanded, setExpanded] = useState(false);
	return (
		<div className="approval-prompt">
			<div className="approval-prompt-head">
				<span className="approval-prompt-title">审批请求</span>
				<span className="badge badge-warn">待处理</span>
			</div>
			<p className="approval-prompt-summary">{summary}</p>
			{detail !== undefined && detail !== "" && (
				<div>
					<button
						type="button"
						className="btn btn-link"
						onClick={() => {
							setExpanded((v) => !v);
						}}
					>
						{expanded ? "收起详情" : "展开详情"}
					</button>
					{expanded && <pre className="approval-prompt-detail">{detail}</pre>}
				</div>
			)}
			<div className="approval-prompt-buttons">
				<button
					type="button"
					className="btn btn-primary"
					onClick={() => {
						onAnswer("allow");
					}}
				>
					允许
				</button>
				<button
					type="button"
					className="btn btn-danger"
					onClick={() => {
						onAnswer("deny");
					}}
				>
					拒绝
				</button>
			</div>
		</div>
	);
}
