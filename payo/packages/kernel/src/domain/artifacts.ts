import { createHash } from "node:crypto";
import { Sha256 } from "@payo/contracts";

export function sha256Hex(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Rejects anything that is not a lowercase sha256, before it can name a file. */
export function assertSha256(name: string): void {
	if (!Sha256.safeParse(name).success) {
		throw new Error(`not a sha256 artifact name: ${JSON.stringify(name)}`);
	}
}
