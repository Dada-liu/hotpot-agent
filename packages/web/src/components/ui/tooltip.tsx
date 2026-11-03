import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { createContext, type ReactElement, useContext, useState } from "react";
import { cn } from "@/lib/utils";

// 点击触发器即收起气泡的关闭通道：Radix 默认只在指针离开/失焦时关闭，
// 点完按钮（如「添加附件」「当前工作区」）tip 会一直悬留，故由 Tooltip 受控
// open + Trigger 的 pointerdown 主动收起
const TooltipCloseContext = createContext<(() => void) | null>(null);

function TooltipProvider({
	delayDuration = 0,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
	return (
		<TooltipPrimitive.Provider
			data-slot="tooltip-provider"
			delayDuration={delayDuration}
			{...props}
		/>
	);
}

// Tooltip 统一走受控 open：内部维护状态，任一时刻都可被 Trigger 的点击强制关闭；
// 调用方若显式传 open 则完全受控（关闭由调用方决定）
function Tooltip({
	open: openProp,
	defaultOpen = false,
	onOpenChange,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>): ReactElement {
	const [open, setOpen] = useState(defaultOpen);
	const controlled = openProp !== undefined;
	const close = (): void => {
		if (!controlled) setOpen(false);
	};
	return (
		<TooltipCloseContext.Provider value={close}>
			<TooltipPrimitive.Root
				data-slot="tooltip"
				open={controlled ? openProp : open}
				onOpenChange={(next) => {
					if (!controlled) setOpen(next);
					onOpenChange?.(next);
				}}
				{...props}
			/>
		</TooltipCloseContext.Provider>
	);
}

// 按下（pointerdown）与点击（click）都收起：pointerdown 让鼠标按下即消失，
// click 覆盖键盘激活与 el.click() 等无 pointerdown 的场景；触发器自身的
// onPointerDown/onClick 仍照常执行
function TooltipTrigger({
	onPointerDown,
	onClick,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>): ReactElement {
	const close = useContext(TooltipCloseContext);
	return (
		<TooltipPrimitive.Trigger
			data-slot="tooltip-trigger"
			onPointerDown={(e) => {
				close?.();
				onPointerDown?.(e);
			}}
			onClick={(e) => {
				close?.();
				onClick?.(e);
			}}
			{...props}
		/>
	);
}

function TooltipContent({
	className,
	sideOffset = 0,
	children,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>): ReactElement {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				data-slot="tooltip-content"
				sideOffset={sideOffset}
				className={cn(
					"z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
					className,
				)}
				{...props}
			>
				{children}
				<TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
			</TooltipPrimitive.Content>
		</TooltipPrimitive.Portal>
	);
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
