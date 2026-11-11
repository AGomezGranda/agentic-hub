import { join } from "node:path";
import {
	ExecutionNamingRequest,
	ExecutionRunConfig,
	type ImplementPreview,
	ImplementPreviewRequest,
	type PublicationPolicy,
} from "@payo/contracts";
import {
	type ExecutionWorkspace,
	type RunStore,
	sha256Hex,
} from "@payo/kernel";
import { loadCheckpoint } from "../artifacts.ts";
import {
	detectTicketIds,
	renderBranch,
	renderCommitSubject,
	renderPrTitle,
	resolveTicketSelection,
	suggestSlug,
	validatePublicationPolicy,
} from "../domain/naming.ts";
import { CommandError } from "../errors.ts";
import { mutableExecutionHandle } from "../execution-handle.ts";
import { validateRunId } from "../plans.ts";
import { checkpoint } from "./checkpoint.ts";
import {
	executionId,
	readApprovedExecutionSource,
	selectedPr,
} from "./source.ts";

export async function previewExecutionNaming(
	deps: { store: RunStore; workspace: Pick<ExecutionWorkspace, "resolveBase"> },
	sourceRunId: string,
	request: ImplementPreviewRequest,
	overrides: Partial<PublicationPolicy>,
	signal: AbortSignal,
): Promise<ImplementPreview> {
	signal.throwIfAborted();
	validateRunId(sourceRunId);
	const input = ImplementPreviewRequest.parse(request);
	const policy = validatePublicationPolicy(overrides);
	const approved = await readApprovedExecutionSource(deps, sourceRunId);
	const pr = selectedPr(approved.plan.version.plan, input.prId);
	const checkpoint = await loadCheckpoint(
		deps.store,
		await deps.store.read(sourceRunId),
	);
	const workItem = checkpoint.workItem;
	if (!workItem)
		throw new CommandError("conflict", "source work item artifact is missing");
	const result: ImplementPreview = {
		candidates:
			workItem.origin.source === "jira"
				? [workItem.origin.key]
				: detectTicketIds(workItem.description),
		slug: input.slug ?? suggestSlug(pr.title),
		errors: {},
	};
	function field<T>(name: string, render: () => T): T | undefined {
		try {
			return render();
		} catch (error) {
			if (!(error instanceof CommandError) || error.code !== "invalid_request")
				throw error;
			result.errors[name] = error.message;
			return undefined;
		}
	}
	const selection = field("ticketId", () =>
		resolveTicketSelection(
			workItem.origin,
			workItem.description,
			input.ticketId,
		),
	);
	if (selection) {
		result.ticketId = selection.ticketId;
		result.branch = field("slug", () =>
			renderBranch(
				policy,
				selection.ticketId,
				result.slug,
				executionId(sourceRunId, approved.plan.ref.sha256, input.prId),
			),
		);
		result.commitSubject = field("commitSubject", () =>
			renderCommitSubject(policy, selection.ticketId, pr.phases[0] ?? pr.title),
		);
		result.prTitle = field("prTitle", () =>
			renderPrTitle(policy, selection.ticketId, pr.title),
		);
	}
	if (Object.keys(result.errors).length === 0) {
		const baseCommit = await deps.workspace.resolveBase(
			approved.state.repo,
			input.base ?? approved.state.baseBranch,
			signal,
		);
		signal.throwIfAborted();
		result.baseCommit = baseCommit;
		result.previewHash = sha256Hex(
			new TextEncoder().encode(
				JSON.stringify({
					plan: approved.plan.ref,
					pr,
					baseCommit,
					policy,
					ticketId: result.ticketId,
					slug: result.slug,
				}),
			),
		);
	}
	return result;
}

export async function correctExecutionNaming(
	handle: import("../execution-handle.ts").ExecutionHandle,
	request: import("@payo/contracts").ExecutionNamingRequest,
	signal: AbortSignal,
): Promise<ImplementPreview> {
	const state = mutableExecutionHandle(handle);
	if (state.busy) throw new CommandError("busy", "execution command busy");
	state.busy = true;
	try {
		const input = ExecutionNamingRequest.parse(request);
		const run = state.log.current();
		const config = ExecutionRunConfig.parse(run.config.factory);
		const stored = state.checkpoint.naming ?? config.naming;
		if (
			!stored ||
			run.status !== "active" ||
			state.checkpoint.workspace ||
			state.checkpoint.commitIntent ||
			state.checkpoint.manifest
		)
			throw new CommandError(
				"conflict",
				"naming can change only before workspace creation",
			);
		const branch = renderBranch(
			stored.policy,
			stored.ticketId,
			input.slug,
			run.runId,
		);
		const previewHash = sha256Hex(
			new TextEncoder().encode(
				JSON.stringify({
					runId: run.runId,
					revision: state.checkpoint.revision,
					stored,
					base: config.baseCommit,
					branch,
				}),
			),
		);
		const result: ImplementPreview = {
			candidates: stored.ticketId ? [stored.ticketId] : [],
			ticketId: stored.ticketId,
			slug: input.slug,
			branch,
			errors: {},
			previewHash,
		};
		if (input.previewHash !== undefined) {
			if (input.previewHash !== previewHash)
				throw new CommandError("conflict", "naming preview is stale");
			if (!state.deps.workspace || !state.deps.dataDir)
				throw new CommandError("conflict", "workspace adapter is required");
			// A lost prepare response can leave a worktree without a checkpoint.
			try {
				await state.deps.workspace.inspect(
					join(state.deps.dataDir, "worktrees", run.runId),
					signal,
				);
			} catch (error) {
				if (signal.aborted) throw error;
				if (
					!(
						error &&
						typeof error === "object" &&
						"code" in error &&
						error.code === "ENOENT"
					)
				)
					throw error;
				await checkpoint(state, {
					naming: { ...stored, slug: input.slug, branch },
				});
				return result;
			}
			throw new CommandError(
				"conflict",
				"workspace already exists; naming is immutable",
			);
		}
		return result;
	} finally {
		state.busy = false;
	}
}
