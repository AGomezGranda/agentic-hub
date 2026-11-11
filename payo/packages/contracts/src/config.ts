import { z } from "zod";
import { ExecutionCheck } from "./execution.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const nonBlank = z.string().trim().min(1, "must not be blank");
const modelPart = nonBlank.refine((value) => !value.includes("/"), {
	error: "must not include '/'",
});

/** Host-agnostic absolute-path check; @payo/config retains node:path.isAbsolute. */
function isPortableAbsolutePath(value: string): boolean {
	return (
		value.startsWith("/") ||
		value.startsWith("\\\\") ||
		/^[A-Za-z]:[\\/]/.test(value)
	);
}

export function isExactLoopbackOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			LOOPBACK.has(url.hostname) &&
			url.pathname === "/" &&
			url.search === "" &&
			url.hash === "" &&
			url.origin === value
		);
	} catch {
		return false;
	}
}

const absolutePath = nonBlank.refine(isPortableAbsolutePath, {
	error: "must be an absolute path",
});
const webOrigin = z
	.string()
	.refine(isExactLoopbackOrigin, "must be an exact http(s) loopback origin");

const modelSelectionSchema = z.strictObject({
	provider: modelPart,
	id: modelPart,
});

const roleSchema = z.strictObject({
	timeout_ms: z.number().int().min(1).max(2_147_483_647).optional(),
	model: modelSelectionSchema.optional(),
});

export const PayoConfigDocument = z.strictObject({
	server: z
		.strictObject({
			port: z.number().int().min(1).max(65535).optional(),
			web_origins: z.array(webOrigin).optional(),
		})
		.optional(),
	paths: z
		.strictObject({
			data_dir: absolutePath.optional(),
			repo: absolutePath.optional(),
			base_branch: nonBlank.optional(),
		})
		.optional(),
	execution: z
		.strictObject({
			max_concurrent_agents: z.number().int().positive().optional(),
			checks: z
				.array(ExecutionCheck)
				.min(1)
				.refine(
					(items) =>
						new Set(items.map((item) => item.name)).size === items.length,
					"duplicate check name",
				)
				.optional(),
		})
		.optional(),
	publication: z
		.strictObject({
			remote: nonBlank.optional(),
			branch_template: z.string().optional(),
			commit_template: z.string().optional(),
			pr_title_template: z.string().optional(),
			pr_body_template: z.string().optional(),
		})
		.optional(),
	tools: z
		.strictObject({
			pi: nonBlank.optional(),
			acli: nonBlank.optional(),
			git: nonBlank.optional(),
			gh: nonBlank.optional(),
		})
		.optional(),
	model: modelSelectionSchema.optional(),
	roles: z
		.strictObject({
			planner: roleSchema.optional(),
			reviewer: roleSchema.optional(),
			verifier: roleSchema.optional(),
			reviser: roleSchema.optional(),
			implementer: roleSchema.optional(),
		})
		.optional(),
});
export type PayoConfigDocument = z.infer<typeof PayoConfigDocument>;

export const ConfigSettingsSnapshot = z.strictObject({
	configFile: nonBlank,
	revision: nonBlank,
	document: PayoConfigDocument,
	environmentOverrides: z.array(nonBlank),
});
export type ConfigSettingsSnapshot = z.infer<typeof ConfigSettingsSnapshot>;

export const SaveConfigSettingsRequest = z.strictObject({
	revision: nonBlank,
	document: PayoConfigDocument,
});
export type SaveConfigSettingsRequest = z.infer<
	typeof SaveConfigSettingsRequest
>;
