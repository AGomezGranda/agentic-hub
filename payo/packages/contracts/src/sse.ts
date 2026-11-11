export interface SseBlock {
	id?: number;
	data: string;
}

export class SseParser {
	private buffer = "";
	private data: string[] = [];
	private id: number | undefined;

	push(chunk: string): SseBlock[] {
		this.buffer += chunk;
		const blocks: SseBlock[] = [];
		while (true) {
			const lf = this.buffer.indexOf("\n");
			const cr = this.buffer.indexOf("\r");
			const candidates = [lf, cr].filter((index) => index >= 0);
			if (candidates.length === 0) break;
			const index = Math.min(...candidates);
			if (this.buffer[index] === "\r" && index === this.buffer.length - 1)
				break;
			const line = this.buffer.slice(0, index);
			const lineEnding =
				this.buffer[index] === "\r" && this.buffer[index + 1] === "\n" ? 2 : 1;
			this.buffer = this.buffer.slice(index + lineEnding);
			this.consumeLine(line, blocks);
		}
		return blocks;
	}

	private consumeLine(line: string, blocks: SseBlock[]): void {
		if (line === "") {
			if (this.data.length > 0) {
				blocks.push({
					...(this.id === undefined ? {} : { id: this.id }),
					data: this.data.join("\n"),
				});
			}
			this.data = [];
			this.id = undefined;
			return;
		}
		if (line.startsWith(":")) return;
		const separator = line.indexOf(":");
		const field = separator < 0 ? line : line.slice(0, separator);
		const value =
			separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
		if (field === "data") this.data.push(value);
		if (field === "id" && !value.includes("\0") && /^\d+$/.test(value))
			this.id = Number(value);
	}
}
