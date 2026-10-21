// 审批条：pendingApproval 时内联渲染（橙色高亮卡片）。summary + 可展开 detail + 允许/拒绝。
// 注意：approvalType "plan" 的审批由 plan 卡片承担（与 plan(drafted) 同源），
// 本组件只处理 tool 型审批。
// busy（应答提交中）：两个按钮禁用、允许键转 loading，防重复点击产生二次应答 404

import {
	ChevronDown,
	ChevronRight,
	Loader2,
	ShieldQuestion,
} from "lucide-react";
import { type ReactElement, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface ApprovalPromptProps {
	summary: string;
	detail?: string;
	onAnswer: (decision: "allow" | "deny") => void;
	busy?: boolean;
}

export function ApprovalPrompt({
	summary,
	detail,
	onAnswer,
	busy = false,
}: ApprovalPromptProps): ReactElement {
	const [expanded, setExpanded] = useState(false);
	return (
		<Card className="gap-3 rounded-xl border-brand/40 bg-brand-soft/60 p-4">
			<div className="flex items-center gap-2">
				<ShieldQuestion className="size-4 shrink-0 text-brand" />
				<span className="text-sm font-semibold">审批请求</span>
				<Badge className="ml-auto bg-brand text-[11px] text-white hover:bg-brand">
					待处理
				</Badge>
			</div>
			<p className="text-sm">{summary}</p>
			{detail !== undefined && detail !== "" && (
				<div>
					<Button
						variant="ghost"
						size="sm"
						className="h-6 gap-1 px-2 text-xs text-muted-foreground"
						disabled={busy}
						onClick={() => {
							setExpanded((v) => !v);
						}}
					>
						{expanded ? (
							<ChevronDown className="size-3" />
						) : (
							<ChevronRight className="size-3" />
						)}
						{expanded ? "收起详情" : "展开详情"}
					</Button>
					{expanded && (
						<pre className="mt-1 overflow-x-auto rounded-md bg-background p-2 font-mono text-xs">
							{detail}
						</pre>
					)}
				</div>
			)}
			<div className="flex gap-2">
				<Button
					size="sm"
					disabled={busy}
					onClick={() => {
						onAnswer("allow");
					}}
				>
					{busy ? <Loader2 className="size-3 animate-spin" /> : null}
					{busy ? "提交中…" : "允许"}
				</Button>
				<Button
					size="sm"
					variant="destructive"
					disabled={busy}
					onClick={() => {
						onAnswer("deny");
					}}
				>
					拒绝
				</Button>
			</div>
		</Card>
	);
}
