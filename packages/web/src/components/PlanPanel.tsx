// plan 审查卡片：橙色高亮卡片 + Markdown 计划正文 + 批准/拒绝/批注操作。
// 批注/拒绝需附 note（server 对 reject/annotate 强制要求），批准后按钮区收起。

import { ListChecks } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
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
		<Card className="gap-3 rounded-xl border-brand/40 bg-brand-soft/60 p-4">
			<div className="flex items-center gap-2">
				<ListChecks className="size-4 shrink-0 text-brand" />
				<span className="text-sm font-semibold">执行计划</span>
				<Badge
					variant={pending ? "default" : "secondary"}
					className={cn(
						"ml-auto text-[11px]",
						pending && "bg-brand text-white",
					)}
				>
					{PHASE_LABEL[phase]}
				</Badge>
			</div>
			{plan !== undefined && plan !== "" && (
				<div className="md text-sm">
					<Markdown text={plan} />
				</div>
			)}
			{pending && (
				<div className="flex flex-col gap-2">
					<Textarea
						className="min-h-[52px] resize-y bg-background text-sm"
						placeholder="批注（拒绝/批注时必填）"
						value={note}
						onChange={(e) => {
							setNote(e.target.value);
						}}
					/>
					<div className="flex gap-2">
						<Button
							size="sm"
							onClick={() => {
								onDecide("approve");
							}}
						>
							批准
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={!noteReady}
							onClick={() => {
								onDecide("annotate", note.trim());
							}}
						>
							批注
						</Button>
						<Button
							size="sm"
							variant="destructive"
							disabled={!noteReady}
							onClick={() => {
								onDecide("reject", note.trim());
							}}
						>
							拒绝
						</Button>
					</div>
				</div>
			)}
		</Card>
	);
}
