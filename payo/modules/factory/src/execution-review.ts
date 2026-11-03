import { randomUUID } from "node:crypto";
import {
	type ArtifactRef,
	type ExecutionCheckpoint,
	ExecutionManifest as ExecutionManifestSchema,
	ExecutionRunConfig as ExecutionRunConfigSchema,
	ExecutionScopeMap,
	type Finding,
	ImplementationReviewOutput,
	ImplementationVerificationOutput,
	jsonEnvelope,
	PhaseReceipt,
	type VerifiedOutput,
} from "@payo/contracts";
import { fanOut, runAgentStep } from "@payo/kernel";
import { readArtifact } from "./artifacts.ts";
import { storeExecutionCheckpoint } from "./execution-artifacts.ts";
import type {
	ExecutionHandle,
	ExecutionReviewRoleSnapshots,
	MutableExecutionHandle,
} from "./execution-handle.ts";
import { mutableExecutionHandle } from "./execution-handle.ts";
import {
	executionReviewSpec,
	executionScoutSpec,
	executionVerifierSpec,
	IMPLEMENTATION_LENSES,
	type ImplementationLens,
} from "./execution-roles.ts";
import {
	applyExecutionCheckpoint,
	decideImplementationReview,
} from "./execution-state.ts";

const MAX_DIFF_BYTES = 4 * 1024 * 1024;
export const IMPLEMENTATION_REVIEW_LENSES = Object.keys(
	IMPLEMENTATION_LENSES,
) as ImplementationLens[];

export interface ImplementationReviewResult {
	decision: "Repair" | "Accepted" | "Escalated";
	blockerIds: string[];
	reason: string | null;
	findings: Finding[];
	unchecked: string[];
	planIssues: string[];
	reviewRef: ArtifactRef | null;
	diffRef: ArtifactRef | null;
	fingerprint: string;
	startCommit: string;
}

/** Reviews one immutable, checked workspace snapshot through all mandatory lenses. */
export async function reviewImplementation(
	handle: ExecutionHandle,
	scope: "phase" | "final",
	signal: AbortSignal,
): Promise<ImplementationReviewResult> {
	const state = mutableExecutionHandle(handle);
	return reviewMutableImplementation(state, scope, signal);
}

export async function reviewMutableImplementation(
	state: MutableExecutionHandle,
	scope: "phase" | "final",
	signal: AbortSignal,
): Promise<ImplementationReviewResult> {
	const { deps, log, checkpoint } = state;
	const config = ExecutionRunConfigSchema.parse(log.current().config.factory);
	const workspace = deps.workspace;
	const runner = deps.runner;
	const limiter = deps.limiter;
	if (!workspace || !runner || !limiter)
		throw new Error("implementation review adapters are not configured");
	const identity = checkpoint.workspace;
	const checksRef = checkpoint.evidence.checks;
	const instructionsRef = log
		.current()
		.artifacts.findLast(
			(ref) => ref.kind === "factory-execution-repository-instructions-v1",
		);
	const manifestRef = checkpoint.manifest;
	if (!identity || !checksRef || !instructionsRef || !manifestRef)
		throw new Error("implementation review is missing immutable evidence");
	const before = await workspace.inspect(identity.path, signal);
	if (before.fingerprint !== identity.fingerprint)
		return failedReview(
			"workspace changed after checks; review evidence is stale",
			before,
			config.baseCommit,
			checkpoint.evidence.diff,
		);
	const checkEvidence = parseJson(await readArtifact(deps.store, checksRef));
	if (!hasPassingStableChecks(checkEvidence, before.fingerprint))
		return failedReview(
			"review requires stable checks for the current workspace fingerprint",
			before,
			config.baseCommit,
			checkpoint.evidence.diff,
		);

	const manifest = ExecutionManifestSchema.parse(
		parseJson(await readArtifact(deps.store, manifestRef)),
	);
	const phase = manifest.phases[checkpoint.phaseIndex];
	if (!phase)
		throw new Error(`phase ${checkpoint.phaseIndex} is absent from manifest`);
	const startCommit =
		scope === "final"
			? config.baseCommit
			: checkpoint.receipts.length > 0
				? await receiptResultCommit(state, checkpoint.receipts.at(-1))
				: config.baseCommit;
	const diff = await workspace.diff(
		identity.path,
		startCommit,
		signal,
		MAX_DIFF_BYTES,
	);
	if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES)
		return failedReview(
			"implementation review diff exceeds the 4 MiB bound",
			before,
			startCommit,
			checkpoint.evidence.diff,
		);
	const afterDiff = await workspace.inspect(identity.path, signal);
	if (afterDiff.fingerprint !== before.fingerprint)
		return failedReview(
			"workspace changed while capturing review diff",
			afterDiff,
			startCommit,
			checkpoint.evidence.diff,
		);
	const diffRef = await recordArtifact(
		state,
		diff,
		"factory-execution-review-diff-v1",
		"text/x-diff",
	);
	const receipts = await Promise.all(
		checkpoint.receipts.map(async (ref) =>
			PhaseReceipt.parse(parseJson(await readArtifact(deps.store, ref))),
		),
	);
	const phaseRef = await recordJsonArtifact(
		state,
		scope === "final"
			? {
					scope,
					pr: manifest.pr,
					phases: manifest.phases,
					phaseIndex: checkpoint.phaseIndex,
					startCommit,
					receipts,
					workspace: {
						branch: identity.branch,
						path: identity.path,
						fingerprint: before.fingerprint,
					},
				}
			: {
					scope,
					phase,
					phaseIndex: checkpoint.phaseIndex,
					startCommit,
					receipts,
					workspace: {
						branch: identity.branch,
						path: identity.path,
						fingerprint: before.fingerprint,
					},
				},
		"factory-execution-review-scope-v1",
	);
	const instructionMap = parseJson(
		await readArtifact(deps.store, instructionsRef),
	);
	if (
		typeof instructionMap !== "object" ||
		instructionMap === null ||
		Array.isArray(instructionMap)
	)
		throw new Error("repository instruction artifact is invalid");
	const instructions = instructionMap as Record<string, unknown>;
	const reviewRoles = await resolveReviewRoles(
		state,
		config.sourceRunId,
		config.baseCommit,
		config.roles,
		config.roleArtifacts,
	);
	const scoutRef = reviewRoles.roleArtifacts.scout;
	const reviewerRef = reviewRoles.roleArtifacts.reviewer;
	const verifierRef = reviewRoles.roleArtifacts.verifier;
	const scoutSettings = reviewRoles.roles.scout;
	const reviewerSettings = reviewRoles.roles.reviewer;
	const verifierSettings = reviewRoles.roles.verifier;
	if (
		!scoutRef ||
		!reviewerRef ||
		!verifierRef ||
		!scoutSettings ||
		!reviewerSettings ||
		!verifierSettings
	)
		throw new Error("implementation review role snapshots are incomplete");
	const scoutId = randomUUID();
	const lensStepIds = new Map(
		IMPLEMENTATION_REVIEW_LENSES.map((lens) => [lens, randomUUID()]),
	);
	const verifierId = randomUUID();
	await writeReviewCheckpoint(state, {
		stage: "Review",
		inFlight: {
			operation: "Review",
			stepIds: [scoutId, ...lensStepIds.values(), verifierId],
		},
		statusDetail: "reviewing-implementation",
	});
	const scout = await runAgentStep(
		{ store: deps.store, log, limiter },
		{
			stepId: scoutId,
			stepName: `scope implementation review (${scope})`,
			attemptIds: [randomUUID(), randomUUID()],
			runner,
			spec: await executionScoutSpec(deps.store, scoutRef, {
				plan: config.plan,
				phase: phaseRef,
				diff: diffRef,
				repositoryInstructions: instructionsRef,
				cwd: identity.path,
				...scoutSettings,
			}),
			validate: jsonEnvelope(ExecutionScopeMap),
			signal,
		},
	);
	const unchecked: string[] = [];
	const findings: Finding[] = [];
	let planIssues: string[] = [];
	const lensReports: Array<{
		lens: ImplementationLens;
		checked: string[];
		findings: Finding[];
		ref: ArtifactRef;
	}> = [];
	let scopeMapRef: ArtifactRef | null = null;
	if (scout.outcome !== "succeeded") unchecked.push("scout");
	else {
		const scopeMap = ExecutionScopeMap.parse(scout.value);
		validateScopeMap(scopeMap, diffPaths(diff), instructions);
		planIssues = scopeMap.planIssues;
		scopeMapRef = await recordJsonArtifact(
			state,
			scopeMap,
			"factory-execution-scope-map-v1",
		);
	}

	if (unchecked.length === 0 && planIssues.length === 0 && scopeMapRef) {
		const reports = await fanOut(
			IMPLEMENTATION_REVIEW_LENSES.map((lens) => async () => {
				const stepId = lensStepIds.get(lens);
				if (!stepId) throw new Error(`missing step id for lens ${lens}`);
				return runAgentStep(
					{ store: deps.store, log, limiter },
					{
						stepId,
						stepName: `implementation-review:${lens}`,
						attemptIds: [randomUUID(), randomUUID()],
						runner,
						spec: await executionReviewSpec(deps.store, reviewerRef, {
							lens,
							plan: config.plan,
							phase: phaseRef,
							diff: diffRef,
							checks: checksRef,
							scopeMap: scopeMapRef as ArtifactRef,
							repositoryInstructions: instructionsRef,
							cwd: identity.path,
							...reviewerSettings,
						}),
						validate: (text) => validateLensOutput(text, lens),
						signal,
					},
				);
			}),
		);
		for (const [index, child] of reports.entries()) {
			const lens = IMPLEMENTATION_REVIEW_LENSES[index];
			if (!lens) continue;
			if (child.status === "unchecked" || child.value.outcome !== "succeeded") {
				unchecked.push(lens);
				continue;
			}
			const value = ImplementationReviewOutput.parse(child.value.value);
			findings.push(...value.findings);
			const ref = await recordJsonArtifact(
				state,
				{
					lens,
					scope,
					fingerprint: before.fingerprint,
					startCommit,
					checked: value.checked,
					findings: value.findings,
				},
				"factory-execution-lens-report-v1",
			);
			lensReports.push({
				lens,
				checked: value.checked,
				findings: value.findings,
				ref,
			});
		}
	}

	let verdicts: ImplementationVerificationOutput["verdicts"] = [];
	if (
		unchecked.length === 0 &&
		planIssues.length === 0 &&
		lensReports.length === IMPLEMENTATION_REVIEW_LENSES.length &&
		scopeMapRef
	) {
		const reportsRef = await recordJsonArtifact(
			state,
			{
				scope,
				fingerprint: before.fingerprint,
				reports: lensReports.map(({ lens, checked, findings: items, ref }) => ({
					lens,
					checked,
					findings: items,
					ref,
				})),
			},
			"factory-execution-lens-reports-v1",
		);
		const verification = await runAgentStep(
			{ store: deps.store, log, limiter },
			{
				stepId: verifierId,
				stepName: "verify implementation review evidence",
				attemptIds: [randomUUID(), randomUUID()],
				runner,
				spec: await executionVerifierSpec(deps.store, verifierRef, {
					plan: config.plan,
					phase: phaseRef,
					diff: diffRef,
					checks: checksRef,
					scopeMap: scopeMapRef,
					repositoryInstructions: instructionsRef,
					reports: reportsRef,
					cwd: identity.path,
					...verifierSettings,
				}),
				validate: jsonEnvelope(ImplementationVerificationOutput),
				signal,
			},
		);
		if (verification.outcome !== "succeeded") unchecked.push("verifier");
		else {
			const output = ImplementationVerificationOutput.parse(verification.value);
			verdicts = output.verdicts;
			planIssues.push(...output.planIssues);
		}
	}

	const afterReview = await workspace.inspect(identity.path, signal);
	const acceptedFindingIds = checkpoint.acceptedFindingIds;
	const unresolvedFindingIds = checkpoint.unresolvedFindingIds;
	if (afterReview.fingerprint !== before.fingerprint) {
		const ref = await recordJsonArtifact(
			state,
			{
				scope,
				fingerprint: before.fingerprint,
				afterFingerprint: afterReview.fingerprint,
				discarded: true,
				findings,
				unchecked,
			},
			"factory-execution-review-v1",
		);
		return {
			decision: "Escalated",
			blockerIds: [],
			reason:
				"workspace mutated during review; all review evidence was discarded",
			findings,
			unchecked,
			planIssues,
			reviewRef: ref,
			diffRef,
			fingerprint: before.fingerprint,
			startCommit,
		};
	}
	const decision = decideImplementationReview(
		findings,
		{ verdicts } as VerifiedOutput,
		unchecked,
		checkpoint.round,
		planIssues,
	);
	const reviewRef = await recordJsonArtifact(
		state,
		{
			scope,
			fingerprint: before.fingerprint,
			startCommit,
			diff: diffRef,
			checks: checksRef,
			scopeMap: scopeMapRef,
			lenses: lensReports.map(({ lens, checked }) => ({ lens, checked })),
			unchecked,
			findings,
			verdicts,
			planIssues,
			acceptedFindingIds,
			unresolvedFindingIds,
		},
		"factory-execution-review-v1",
	);
	return {
		...decision,
		findings,
		unchecked,
		planIssues,
		reviewRef,
		diffRef,
		fingerprint: before.fingerprint,
		startCommit,
	};
}

function hasPassingStableChecks(value: unknown, fingerprint: string): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const evidence = value as {
		stable?: unknown;
		afterFingerprint?: unknown;
		commands?: unknown;
		results?: unknown;
	};
	if (
		evidence.stable !== true ||
		evidence.afterFingerprint !== fingerprint ||
		!Array.isArray(evidence.commands) ||
		evidence.commands.length === 0 ||
		!Array.isArray(evidence.results) ||
		evidence.results.length !== evidence.commands.length
	)
		return false;
	const commands: unknown[] = evidence.commands;
	const results: unknown[] = evidence.results;
	return results.every((result, index) => {
		const command = commands[index];
		return (
			typeof result === "object" &&
			result !== null &&
			typeof command === "object" &&
			command !== null &&
			"status" in result &&
			result.status === "passed" &&
			"name" in result &&
			typeof result.name === "string" &&
			"name" in command &&
			typeof command.name === "string" &&
			result.name === command.name
		);
	});
}

function validateLensOutput(text: string, lens: ImplementationLens) {
	const parsed = jsonEnvelope(ImplementationReviewOutput)(text);
	if (!parsed.ok) return parsed;
	try {
		const output = ImplementationReviewOutput.parse(parsed.value);
		const ids = new Set<string>();
		for (const finding of output.findings) {
			if (!finding.id.startsWith(`${lens}:`))
				throw new Error(`finding ${finding.id} must be prefixed with ${lens}:`);
			if (ids.has(finding.id))
				throw new Error(`duplicate finding id ${finding.id}`);
			ids.add(finding.id);
		}
		return parsed;
	} catch (error) {
		return {
			ok: false as const,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function diffPaths(diff: string): string[] {
	return [
		...new Set(
			[...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(
				(match) => match[2] ?? match[1] ?? "",
			),
		),
	].sort();
}

function validateScopeMap(
	scopeMap: ReturnType<typeof ExecutionScopeMap.parse>,
	changedPaths: string[],
	instructions: Record<string, unknown>,
): void {
	const expected = [...changedPaths].sort();
	const actual = scopeMap.files.map((file) => file.path).sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		throw new Error(
			`scout scope map paths [${actual.join(", ")}] do not match changed paths [${expected.join(", ")}]`,
		);
	for (const file of scopeMap.files) {
		const applicable = Object.keys(instructions)
			.filter((instruction) => {
				const directory = instruction.includes("/")
					? instruction.slice(0, instruction.lastIndexOf("/"))
					: "";
				return !directory || file.path.startsWith(`${directory}/`);
			})
			.sort();
		const named = [...file.instructionPaths].sort();
		if (JSON.stringify(named) !== JSON.stringify(applicable))
			throw new Error(
				`scope map must include all and only applicable repository instructions for ${file.path}`,
			);
	}
}

function failedReview(
	reason: string,
	snapshot: { fingerprint: string },
	startCommit: string,
	diffRef: ArtifactRef | null,
): ImplementationReviewResult {
	return {
		decision: "Escalated",
		blockerIds: [],
		reason,
		findings: [],
		unchecked: [],
		planIssues: [],
		reviewRef: null,
		diffRef,
		fingerprint: snapshot.fingerprint,
		startCommit,
	};
}

async function receiptResultCommit(
	state: MutableExecutionHandle,
	ref: ArtifactRef | undefined,
): Promise<string> {
	if (!ref)
		return ExecutionRunConfigSchema.parse(state.log.current().config.factory)
			.baseCommit;
	const value = parseJson(await readArtifact(state.deps.store, ref));
	if (
		typeof value !== "object" ||
		value === null ||
		!("resultCommit" in value) ||
		typeof value.resultCommit !== "string"
	)
		throw new Error("phase receipt has no result commit");
	return value.resultCommit;
}

async function recordArtifact(
	state: MutableExecutionHandle,
	value: string,
	kind: string,
	mediaType: string,
): Promise<ArtifactRef> {
	const ref = await state.deps.store.putArtifact(
		new TextEncoder().encode(value),
		{ kind, mediaType },
	);
	await state.log.write([
		{ type: "artifact.recorded", artifact: ref, attemptId: null },
	]);
	return ref;
}

async function recordJsonArtifact(
	state: MutableExecutionHandle,
	value: unknown,
	kind: string,
): Promise<ArtifactRef> {
	return recordArtifact(state, JSON.stringify(value), kind, "application/json");
}

async function resolveReviewRoles(
	state: MutableExecutionHandle,
	sourceRunId: string,
	pinnedBase: string,
	configuredRoles: Record<string, { model: string | null; timeoutMs: number }>,
	configuredArtifacts: Record<string, ArtifactRef>,
): Promise<ExecutionReviewRoleSnapshots> {
	const configured = {
		roleArtifacts: {
			scout: configuredArtifacts.scout,
			reviewer: configuredArtifacts.reviewer,
			verifier: configuredArtifacts.verifier,
		},
		roles: {
			scout: configuredRoles.scout,
			reviewer: configuredRoles.reviewer,
			verifier: configuredRoles.verifier,
		},
	};
	if (
		Object.values(configured.roleArtifacts).every(Boolean) &&
		Object.values(configured.roles).every(Boolean)
	)
		return configured as ExecutionReviewRoleSnapshots;
	const existingRef = state.log
		.current()
		.artifacts.findLast(
			(ref) => ref.kind === "factory-execution-review-roles-v1",
		);
	if (existingRef) {
		const parsed = parseJson(await readArtifact(state.deps.store, existingRef));
		if (isReviewRoleSnapshots(parsed)) return parsed;
		throw new Error("persisted execution review roles are invalid");
	}
	const load = state.deps.loadReviewRoleSnapshots;
	if (!load)
		throw new Error(
			"execution review roles are missing and cannot be loaded for this run",
		);
	const loaded = await load(sourceRunId, pinnedBase);
	if (!isReviewRoleSnapshots(loaded))
		throw new Error("execution review role loader returned invalid snapshots");
	await state.log.write([
		...Object.values(loaded.roleArtifacts).map((artifact) => ({
			type: "artifact.recorded" as const,
			artifact,
			attemptId: null,
		})),
	]);
	await recordJsonArtifact(state, loaded, "factory-execution-review-roles-v1");
	return loaded;
}

function isReviewRoleSnapshots(
	value: unknown,
): value is ExecutionReviewRoleSnapshots {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ExecutionReviewRoleSnapshots>;
	return (["scout", "reviewer", "verifier"] as const).every((role) => {
		const artifact = candidate.roleArtifacts?.[role];
		const settings = candidate.roles?.[role];
		return (
			!!artifact &&
			typeof artifact.sha256 === "string" &&
			!!settings &&
			typeof settings.timeoutMs === "number" &&
			(settings.model === null || typeof settings.model === "string")
		);
	});
}

async function writeReviewCheckpoint(
	state: MutableExecutionHandle,
	update: Partial<ExecutionCheckpoint>,
): Promise<void> {
	const current = state.checkpoint;
	const next = applyExecutionCheckpoint(current, current.revision, {
		...current,
		...update,
		revision: current.revision + 1,
	});
	await state.log.write([
		await storeExecutionCheckpoint(state.deps.store, next),
	]);
	state.checkpoint = next;
}

function parseJson(bytes: Uint8Array): unknown {
	return JSON.parse(new TextDecoder().decode(bytes));
}
