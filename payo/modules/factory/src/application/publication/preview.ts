import type { RunIdInput } from "@payo/contracts";
import {
	type ArtifactRef,
	ExecutionManifest,
	ExecutionRunConfig,
	PhaseReceipt,
	PublicationChecks,
	PublicationCommit,
	PublicationFinalResult,
	PublicationPreview,
	RunId,
} from "@payo/contracts";
import { fold, sha256Hex } from "@payo/kernel";
import { CommandError } from "../../domain/errors.ts";
import {
	executionNaming,
	expectedExecutionBranch,
} from "../../domain/execution-naming.ts";
import { renderPrBody, renderPrTitle } from "../../domain/naming.ts";
import {
	assertPublicationBase,
	assertPublicationCheckpoint,
	assertPublicationManifest,
	assertPublicationReceipts,
	assertPublicationResult,
	assertPublicationWorkspace,
	publicationEligibility,
	sameTarget,
	validatePublicationCommits,
} from "../../domain/publication.ts";
import { readArtifact } from "../artifacts.ts";
import { loadExecutionCheckpoint } from "../execution-artifacts.ts";
import type { PublicationDeps } from "./handle.ts";

function conflict(message: string): never {
	throw new CommandError("conflict", message);
}
export function publicationId(executionId: RunIdInput): string {
	const raw = sha256Hex(
		new TextEncoder().encode(`factory-publication\n${executionId}`),
	).slice(0, 32);
	const variant = "89ab"[Number.parseInt(raw[16] ?? "0", 16) & 3];
	return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-${variant}${raw.slice(17, 20)}-${raw.slice(20)}`;
}
export async function publicationEvidence(
	deps: PublicationDeps,
	executionId: RunIdInput,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const events = await deps.store.read(executionId);
	if (!events.length)
		throw new CommandError("not_found", `execution ${executionId} not found`);
	const run = fold(events);
	const config = ExecutionRunConfig.parse(run.config.factory);
	const checkpoint = await loadExecutionCheckpoint(deps.store, events);
	const naming = executionNaming(config, checkpoint);
	if (!naming) conflict("Legacy execution has no confirmed naming snapshot");
	const reason = publicationEligibility(run.status, run.outcome, naming);
	if (reason) conflict(reason);
	const { workspace: identity, manifest: manifestRef } =
		assertPublicationCheckpoint(checkpoint);
	const snapshot = await deps.workspace.inspect(identity.path, signal);
	assertPublicationWorkspace(
		snapshot,
		identity,
		expectedExecutionBranch(config, checkpoint, executionId),
	);
	const readJson = async (ref: ArtifactRef) =>
		JSON.parse(new TextDecoder().decode(await readArtifact(deps.store, ref)));
	const resultRef = run.artifacts.findLast(
		(ref) => ref.kind === "factory-execution-final-result-v1",
	);
	if (!resultRef) conflict("Final reviewed result is missing");
	const result = PublicationFinalResult.parse(await readJson(resultRef));
	assertPublicationResult(result, snapshot.head, checkpoint);
	const manifest = ExecutionManifest.parse(await readJson(manifestRef));
	assertPublicationManifest(manifest, config, checkpoint);
	const receipts = await Promise.all(
		result.phaseReceipts.map(async (ref) =>
			PhaseReceipt.parse(await readJson(ref)),
		),
	);
	assertPublicationReceipts(receipts, manifest, config);
	for (const receipt of receipts) {
		await readJson(receipt.report);
		await readJson(receipt.review);
		PublicationChecks.parse(await readJson(receipt.checks));
	}
	const checks = PublicationChecks.parse(await readJson(result.checks));
	await readJson(result.review);
	await readJson(result.report);
	const commits = (
		await deps.repository.readCommits(
			identity.path,
			config.baseCommit,
			result.resultCommit,
			signal,
		)
	).map((c) => PublicationCommit.parse(c));
	validatePublicationCommits(commits, naming, executionId);
	return {
		run,
		config,
		checkpoint,
		naming,
		result,
		manifest,
		receipts,
		checks,
		commits,
		worktree: identity.path,
	};
}
export async function previewPublication(
	deps: PublicationDeps,
	executionId: RunIdInput,
	signal: AbortSignal,
): Promise<PublicationPreview> {
	try {
		const evidence = await publicationEvidence(deps, executionId, signal);
		const { config, naming, result, manifest, receipts, checks, commits } =
			evidence;
		const remote = await deps.repository.resolveRemote(
			evidence.run.repo,
			naming.policy.remote,
			signal,
		);
		const target = await deps.codeHost.resolveRepository(
			remote.fetchUrl,
			evidence.run.baseBranch,
			signal,
		);
		const pushTarget = await deps.codeHost.resolveRepository(
			remote.pushUrl,
			evidence.run.baseBranch,
			signal,
		);
		if (!sameTarget(target, pushTarget))
			conflict("Fetch and push destinations differ");
		assertPublicationBase(target, config.baseCommit);
		assertPublicationBase(pushTarget, config.baseCommit);
		const title = renderPrTitle(
			naming.policy,
			naming.ticketId,
			manifest.pr.title,
		);
		const body = renderPrBody(naming.policy, {
			ticketId: naming.ticketId,
			prTitle: title,
			summary: result.summary,
			changes: receipts.map((r) => `- ${r.summary}`).join("\n"),
			checks: checks.results.map((c) => `- ${c.name}: ${c.status}`).join("\n"),
			executionId,
		});
		const preview = {
			executionRunId: RunId.parse(executionId),
			eligible: true,
			errors: [],
			target,
			branch: naming.branch,
			reviewedCommit: result.resultCommit,
			baseCommit: config.baseCommit,
			pushUrl: remote.pushUrl,
			title,
			body,
			commits,
		};
		const previewHash = sha256Hex(
			new TextEncoder().encode(
				JSON.stringify({ preview, plan: config.plan, naming }),
			),
		);
		return PublicationPreview.parse({ ...preview, previewHash });
	} catch (error) {
		if (signal.aborted) throw error;
		if (error instanceof CommandError && error.code === "not_found")
			throw error;
		return {
			executionRunId: RunId.parse(executionId),
			eligible: false,
			errors: [error instanceof Error ? error.message : String(error)],
			commits: [],
		};
	}
}
