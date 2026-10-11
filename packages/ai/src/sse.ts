// SSE（Server-Sent Events）字节流解析器，各协议适配器共用。
// 输入 fetch 响应体的字节流，逐事件帧产出 data: 载荷字符串。
// 关键约束：TCP 拆包可能落在多字节 UTF-8 字符或 JSON 行中间，
// 因此用 TextDecoder 流式解码 + 字符串缓冲，只有遇到空行才派发一帧。

// 提取一帧中的 data: 载荷；多行 data 按 SSE 规范以 \n 拼接；无 data 行返回 null。
// 注释行（: 开头，如 keep-alive）与其他字段（event:/id:/retry:）本协议用不到，跳过。
function framePayload(lines: string[]): string | null {
	const dataLines: string[] = [];
	for (const line of lines) {
		if (line.startsWith("data:")) {
			const value = line.slice(5);
			dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
		}
	}
	return dataLines.length > 0 ? dataLines.join("\n") : null;
}

// 去掉行尾 \r（兼容 \r\n 行尾的代理实现）
function stripCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export async function* parseSseStream(
	body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let frame: string[] = [];
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = stripCr(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
				if (line === "") {
					// 空行 = 一帧结束
					const payload = framePayload(frame);
					frame = [];
					// OpenAI 以 data: [DONE] 作为终止哨兵：不产出，直接结束迭代
					if (payload === "[DONE]") return;
					if (payload !== null) yield payload;
				} else {
					frame.push(line);
				}
				nl = buffer.indexOf("\n");
			}
		}
		// 流结束：冲刷解码器残余字节；末尾无换行的最后一帧也要派发
		const tail = stripCr(buffer + decoder.decode());
		if (tail !== "") frame.push(tail);
		const payload = framePayload(frame);
		if (payload !== null && payload !== "[DONE]") yield payload;
	} finally {
		reader.releaseLock();
	}
}
