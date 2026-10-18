// shadcn/ui 生成的组件共用 class 合并工具：clsx 拼类名 + tailwind-merge 去冲突
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
