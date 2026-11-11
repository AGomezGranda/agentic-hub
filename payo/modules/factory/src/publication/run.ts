import { PublicationRunConfig } from "@payo/contracts";
import {
	reconcilePullRequests,
	reconcileRemote,
	sameTarget,
} from "../domain/publication.ts";
import { CommandError } from "../errors.ts";
import { mutablePublication, type PublicationHandle } from "./handle.ts";
import { checkpointPublication, gatePublication } from "./lifecycle.ts";
import { publicationEvidence } from "./preview.ts";
export async function executePublication(
	handle: PublicationHandle,
	input: { signal: AbortSignal },
): Promise<PublicationHandle> {
	const state = mutablePublication(handle);
	if (state.busy) throw new CommandError("busy", "publication is busy");
	if (
		state.log.current().status !== "active" ||
		state.checkpoint.stage === "Escalated"
	)
		return handle;
	input.signal.throwIfAborted();
	state.busy = true;
	let operation: "Push" | "CreatePr" =
		state.checkpoint.stage === "CreatePr" ? "CreatePr" : "Push";
	let stepId: string | undefined;
	try {
		const config = PublicationRunConfig.parse(
			state.log.current().config.factory,
		);
		const { repository, codeHost } = state.deps;
		const evidence = await publicationEvidence(
			state.deps,
			config.executionRunId,
			input.signal,
		);
		if (
			evidence.config.plan.sha256 !== config.plan.sha256 ||
			evidence.result.resultCommit !== config.reviewedCommit ||
			evidence.naming.branch !== config.branch ||
			evidence.worktree !== config.worktree
		)
			throw new CommandError("conflict", "publication source identity changed");
		const recheckBase = async () => {
			const target = await codeHost.resolveRepository(
				config.pushUrl,
				config.target.baseBranch,
				input.signal,
			);
			if (
				!sameTarget(target, config.target) ||
				target.baseCommit !== config.baseCommit
			)
				throw new CommandError(
					"conflict",
					"target base moved; approve a new plan/execution against the updated base",
				);
		};
		await recheckBase();
		if (state.checkpoint.stage === "Push") {
			const observed = await repository.readRemoteHead(
				config.pushUrl,
				config.branch,
				input.signal,
			);
			const action = reconcileRemote(
				observed,
				config.reviewedCommit,
				state.checkpoint.intent !== null,
			);
			if (action === "push") {
				stepId = state.deps.newId();
				await checkpointPublication(
					state,
					{ intent: "Push", observedRemoteSha: observed },
					[{ type: "step.started", stepId, name: "push reviewed commit" }],
				);
				await repository.pushCommit(
					config.worktree,
					config.pushUrl,
					config.branch,
					config.reviewedCommit,
					input.signal,
				);
				const confirmed = await repository.readRemoteHead(
					config.pushUrl,
					config.branch,
					input.signal,
				);
				if (confirmed !== config.reviewedCommit)
					throw new CommandError(
						"conflict",
						"pushed branch could not be confirmed",
					);
			}
			await checkpointPublication(
				state,
				{ stage: "CreatePr", observedRemoteSha: config.reviewedCommit },
				stepId ? [{ type: "step.finished", stepId, outcome: "succeeded" }] : [],
			);
			stepId = undefined;
		}
		operation = "CreatePr";
		await recheckBase();
		if (
			(await repository.readRemoteHead(
				config.pushUrl,
				config.branch,
				input.signal,
			)) !== config.reviewedCommit
		)
			throw new CommandError(
				"conflict",
				"remote branch changed before draft creation",
			);
		let pr = reconcilePullRequests(
			await codeHost.findPullRequests(
				config.target,
				config.branch,
				input.signal,
			),
			config,
		);
		if (pr && state.checkpoint.intent !== "CreatePr")
			throw new CommandError(
				"conflict",
				"pre-existing PR is unowned by a durable creation intent",
			);
		if (!pr) {
			stepId = state.deps.newId();
			await checkpointPublication(state, { intent: "CreatePr" }, [
				{ type: "step.started", stepId, name: "create GitHub draft PR" },
			]);
			await recheckBase();
			await codeHost.createDraftPullRequest(
				config.target,
				{ headBranch: config.branch, title: config.title, body: config.body },
				input.signal,
			);
			pr = reconcilePullRequests(
				await codeHost.findPullRequests(
					config.target,
					config.branch,
					input.signal,
				),
				config,
			);
			if (!pr)
				throw new CommandError("conflict", "draft creation outcome is unknown");
		}
		if (stepId)
			await state.log.write([
				{ type: "step.finished", stepId, outcome: "succeeded" },
			]);
		await checkpointPublication(state, {
			stage: "Completed",
			pr,
			reason: null,
			pausedOperation: null,
		});
		await state.log.write([{ type: "run.ended", outcome: "published" }]);
	} catch (error) {
		if (stepId && state.log.current().steps.get(stepId)?.status === "running")
			await state.log.write([
				{ type: "step.finished", stepId, outcome: "failed" },
			]);
		await gatePublication(
			state,
			operation,
			error instanceof Error ? error.message : String(error),
		);
	} finally {
		state.busy = false;
	}
	return handle;
}
