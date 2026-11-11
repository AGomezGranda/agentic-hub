import {
	type ArtifactRef,
	ExecutionManifest,
	type ExecutionNamingSnapshot,
	ExecutionRunConfig,
	PhaseReceipt,
	PublicationChecks,
	PublicationCommit,
	PublicationFinalResult,
	PublicationPreview,
	type PublishRequest,
} from "@payo/contracts";
import { fold, sha256Hex } from "@payo/kernel";
import { readArtifact } from "../artifacts.ts";
import {
	executionNaming,
	expectedExecutionBranch,
} from "../domain/execution-naming.ts";
import { renderPrBody, renderPrTitle } from "../domain/naming.ts";
import {
	publicationEligibility,
	sameTarget,
	validatePublicationCommits,
	validateTicketTitle,
} from "../domain/publication.ts";
import { CommandError } from "../errors.ts";
import { loadExecutionCheckpoint } from "../execution-artifacts.ts";
import type { PublicationDeps } from "./handle.ts";

function conflict(message: string): never {
	throw new CommandError("conflict", message);
}
export function publicationId(executionId: string): string {
	const raw = sha256Hex(
		new TextEncoder().encode(`factory-publication\n${executionId}`),
	).slice(0, 32);
	const variant = "89ab"[Number.parseInt(raw[16] ?? "0", 16) & 3];
	return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-${variant}${raw.slice(17, 20)}-${raw.slice(20)}`;
}
export async function publicationEvidence(
	deps: PublicationDeps,
	executionId: string,
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
	const identity = checkpoint.workspace;
	if (!identity || !checkpoint.manifest || checkpoint.stage !== "Completed")
		conflict("Reviewed execution evidence is incomplete");
	const snapshot = await deps.workspace.inspect(identity.path, signal);
	if (
		snapshot.branch !==
			expectedExecutionBranch(config, checkpoint, executionId) ||
		snapshot.branch !== identity.branch ||
		snapshot.head !== identity.head ||
		snapshot.changedPaths.length ||
		(identity.fingerprint && snapshot.fingerprint !== identity.fingerprint)
	)
		conflict("Reviewed workspace branch, HEAD or cleanliness changed");
	const readJson = async (ref: ArtifactRef) =>
		JSON.parse(new TextDecoder().decode(await readArtifact(deps.store, ref)));
	const resultRef = run.artifacts.findLast(
		(ref) => ref.kind === "factory-execution-final-result-v1",
	);
	if (!resultRef) conflict("Final reviewed result is missing");
	const result = PublicationFinalResult.parse(await readJson(resultRef));
	if (
		result.resultCommit !== snapshot.head ||
		JSON.stringify(result.phaseReceipts) !==
			JSON.stringify(checkpoint.receipts) ||
		result.checks.sha256 !== checkpoint.evidence.checks?.sha256 ||
		result.review.sha256 !== checkpoint.evidence.review?.sha256
	)
		conflict("Final evidence differs from reviewed checkpoint");
	const manifest = ExecutionManifest.parse(await readJson(checkpoint.manifest));
	if (
		manifest.pr.id !== config.prId ||
		manifest.phases.length !== checkpoint.receipts.length
	)
		conflict("Reviewed manifest/receipts are incomplete");
	const receipts = await Promise.all(
		result.phaseReceipts.map(async (ref) =>
			PhaseReceipt.parse(await readJson(ref)),
		),
	);
	let parent = config.baseCommit;
	for (const [index, receipt] of receipts.entries()) {
		if (
			receipt.phaseIndex !== index ||
			receipt.phaseId !== manifest.phases[index]?.id ||
			receipt.planHash !== config.plan.sha256 ||
			receipt.startCommit !== parent
		)
			conflict("Phase receipt identity differs from reviewed plan");
		await readJson(receipt.report);
		await readJson(receipt.review);
		PublicationChecks.parse(await readJson(receipt.checks));
		parent = receipt.resultCommit;
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
	executionId: string,
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
		if (
			target.baseCommit !== config.baseCommit ||
			pushTarget.baseCommit !== config.baseCommit
		)
			conflict(
				"Target base moved; approve a new plan/execution against the updated base",
			);
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
			executionRunId: executionId,
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
			executionRunId: executionId,
			eligible: false,
			errors: [error instanceof Error ? error.message : String(error)],
			commits: [],
		};
	}
}
export function publicationContent(
	preview: Pick<PublicationPreview, "title" | "body">,
	request: PublishRequest,
	naming: ExecutionNamingSnapshot,
	id: string,
) {
	if (preview.title === undefined || preview.body === undefined)
		conflict("Publication preview is incomplete");
	const title = request.title ?? preview.title;
	validateTicketTitle(title, naming.ticketId);
	const body = request.body ?? preview.body;
	if (body.includes("<!-- payo-publication:"))
		conflict("Publication marker is owned by the factory");
	return { title, body: `${body}\n\n<!-- payo-publication:${id} -->` };
}
