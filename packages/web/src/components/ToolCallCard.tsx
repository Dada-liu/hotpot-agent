// 工具调用卡片：图标 + 名称 + 入参摘要（JSON 截断 200 字符）+ 输出可展开 + isError 橙标。
// 无边框无阴影的轻量样式：工具名行与思考文本左缘对齐，其余内容保持 12px 缩进（mx-3）。

import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { memo, type ReactElement, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

function summarize(input: unknown): string {
	if (input === undefined) {
		return "";
	}
	let text: string;
	try {
		text = JSON.stringify(input) ?? "";
	} catch {
		return String(input);
	}
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

interface ToolCallCardProps {
	name: string;
	input: unknown;
	result?: { content: string; isError: boolean };
}

// memo：打字机流式期间历史工具卡片跳过重渲染
export const ToolCallCard = memo(function ToolCallCard({
	name,
	input,
	result,
}: ToolCallCardProps): ReactElement {
	const [expanded, setExpanded] = useState(false);
	const summary = summarize(input);
	const failed = result?.isError === true;
	return (
		<Card className="min-w-0 gap-2 rounded-xl border-0 p-0 shadow-none">
			<div className="flex items-center gap-2">
				<Wrench className="size-3.5 shrink-0 text-muted-foreground" />
				<span
					className={cn(
						"min-w-0 break-all font-mono text-sm font-medium",
						// 无边框后 failed 态用工具名变色表达（error 徽标保留）
						failed && "text-destructive",
					)}
				>
					{name}
				</span>
				{result !== undefined && (
					<Badge
						variant={failed ? "destructive" : "secondary"}
						className="ml-auto shrink-0 text-[11px]"
					>
						{failed ? "error" : "done"}
					</Badge>
				)}
			</div>
			{/* 工具名行之外的内容保持原卡片 p-3 的 12px 缩进观感 */}
			<div className="mx-3 flex flex-col gap-2">
				{summary !== "" && (
					<pre className="overflow-x-auto rounded-md bg-secondary p-2 font-mono text-xs text-muted-foreground">
						{summary}
					</pre>
				)}
				{result !== undefined && (
					<div>
						<Button
							variant="ghost"
							size="sm"
							className="h-6 gap-1 px-2 text-xs text-muted-foreground"
							onClick={() => {
								setExpanded((v) => !v);
							}}
						>
							{expanded ? (
								<ChevronDown className="size-3" />
							) : (
								<ChevronRight className="size-3" />
							)}
							{expanded ? "收起输出" : "展开输出"}
						</Button>
						{expanded && (
							<pre className="mt-1 max-h-72 overflow-auto rounded-md bg-secondary p-2 font-mono text-xs">
								{result.content}
							</pre>
						)}
					</div>
				)}
			</div>
		</Card>
	);
});
