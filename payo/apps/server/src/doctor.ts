import type { DoctorCheck, DoctorReport } from "@payo/contracts";
import { checkGit, createGitExec } from "@payo/git";
import { checkAcli } from "@payo/jira-acli";
import { checkPi } from "@payo/runner-pi";
import type { ServerConfig } from "./config.ts";
import { checkRoleSources } from "./role-sources.ts";

export interface DoctorProbes {
	pi: typeof checkPi;
	acli: typeof checkAcli;
	git: typeof checkGit;
	roleSources: typeof checkRoleSources;
}

const MAX_DETAIL = 512;

export async function runDoctor(
	config: ServerConfig,
	probes: Partial<DoctorProbes> = {},
): Promise<DoctorReport> {
	const pi = probes.pi ?? checkPi;
	const acli = probes.acli ?? checkAcli;
	const git = probes.git ?? checkGit;
	const roleSources = probes.roleSources ?? checkRoleSources;
	const gitExec = createGitExec({ bin: config.gitBin });

	const checks = await Promise.all([
		safeCheck("pi", () =>
			pi({
				bin: config.piBin,
				provider: config.piProvider,
				model: config.model,
			}),
		),
		safeCheck("acli", () => acli({ bin: config.acliBin })),
		safeCheck("git", () =>
			git({
				bin: config.gitBin,
				repo: config.repo,
				base: config.baseBranch,
				exec: gitExec,
			}),
		),
		safeCheck("skills", () =>
			roleSources(config.repo, config.baseBranch, gitExec),
		),
	]);

	return { ok: checks.every((check) => check.ok), checks };
}

async function safeCheck(
	name: string,
	probe: () => Promise<DoctorCheck>,
): Promise<DoctorCheck> {
	try {
		const check = await probe();
		return { ...check, detail: clean(check.detail) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { name, ok: false, detail: clean(message) };
	}
}

function clean(detail: string): string {
	return clamp(redact(detail), MAX_DETAIL);
}

function redact(text: string): string {
	return text
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/ghp_[A-Za-z0-9]+/g, "[redacted]")
		.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
		.replace(
			/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
			"[redacted]",
		);
}

function clamp(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}
