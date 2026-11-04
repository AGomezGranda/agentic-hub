import {
	type ConfigSettingsSnapshot,
	type ExecutionCheck,
	type PayoConfigDocument,
	PayoConfigDocument as PayoConfigDocumentSchema,
} from "@payo/contracts";
import { DEFAULT_SERVER_PORT, PayoApiError } from "@web/shared/api/client.ts";
import { BrowseButton } from "@web/shared/ui/BrowseButton.tsx";
import { Button } from "@web/shared/ui/Button.tsx";
import { type FormEvent, useEffect, useState } from "react";
import { getConfigSettings, saveConfigSettings } from "./api.ts";

const ROLES = ["planner", "reviewer", "verifier", "reviser"] as const;
type Role = (typeof ROLES)[number];

interface RoleForm {
	provider: string;
	id: string;
	timeoutMs: string;
}

interface SettingsForm {
	port: string;
	webOrigins: string;
	dataDir: string;
	repo: string;
	baseBranch: string;
	maxConcurrentAgents: string;
	pi: string;
	acli: string;
	git: string;
	modelProvider: string;
	modelId: string;
	roles: Record<Role, RoleForm>;
	/** Not exposed by the form; preserved across load and save. */
	checks: ExecutionCheck[];
	implementer: NonNullable<PayoConfigDocument["roles"]>["implementer"];
}

export function SettingsPage({
	token,
	onDirtyChange,
}: {
	token: string;
	onDirtyChange: (dirty: boolean) => void;
}) {
	const [snapshot, setSnapshot] = useState<ConfigSettingsSnapshot | null>(null);
	const [form, setForm] = useState<SettingsForm | null>(null);
	const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
	const [loadError, setLoadError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [isSaving, setIsSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [conflict, setConflict] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);

	const loadedForm = snapshot ? formFromDocument(snapshot.document) : null;
	const dirty =
		form !== null &&
		loadedForm !== null &&
		JSON.stringify(form) !== JSON.stringify(loadedForm);

	useEffect(() => {
		onDirtyChange(dirty);
	}, [dirty, onDirtyChange]);

	useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

	useEffect(() => {
		if (!dirty) return;
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	useEffect(() => {
		const controller = new AbortController();
		setIsLoading(true);
		getConfigSettings(token, controller.signal)
			.then((loaded) => {
				setSnapshot(loaded);
				setForm(formFromDocument(loaded.document));
				setIsLoading(false);
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted) return;
				setLoadError(errorMessage(error, "Could not load settings."));
				setIsLoading(false);
			});
		return () => controller.abort();
	}, [token]);

	if (isLoading && form === null)
		return (
			<p role="status" className="text-sm text-[var(--muted)]">
				Loading settings…
			</p>
		);
	if (form === null || snapshot === null)
		return (
			<div
				role="alert"
				className="rounded-sm border border-[var(--danger-border)] bg-[var(--danger-surface)] px-4 py-3 text-sm text-[var(--danger)]"
			>
				{loadError ?? "Could not load settings."}
			</div>
		);

	const currentForm = form;
	const currentSnapshot = snapshot;

	function update<K extends keyof SettingsForm>(
		key: K,
		value: SettingsForm[K],
	) {
		setForm((current) => (current ? { ...current, [key]: value } : current));
		setSaved(false);
		if (!conflict) setSubmitError(null);
	}

	function updateRole(role: Role, key: keyof RoleForm, value: string) {
		setForm((current) =>
			current
				? {
						...current,
						roles: {
							...current.roles,
							[role]: { ...current.roles[role], [key]: value },
						},
					}
				: current,
		);
		setSaved(false);
		if (!conflict) setSubmitError(null);
	}

	function discard() {
		setForm(formFromDocument(currentSnapshot.document));
		setFieldErrors({});
		setSubmitError(null);
		setSaved(false);
		setConflict(false);
	}

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!dirty) return;
		const result = validateForm(currentForm);
		setFieldErrors(result.errors);
		if (result.document === undefined) {
			setSaved(false);
			setConflict(false);
			setSubmitError(
				result.errors.form ?? "Fix the highlighted settings before saving.",
			);
			return;
		}
		setIsSaving(true);
		setSaved(false);
		setConflict(false);
		setSubmitError(null);
		const submitted = currentForm;
		try {
			const next = await saveConfigSettings(token, {
				revision: currentSnapshot.revision,
				document: result.document,
			});
			setSnapshot(next);
			// Keep edits made while the request was in flight; updates replace the reference.
			setForm((current) =>
				current === submitted ? formFromDocument(next.document) : current,
			);
			setSaved(true);
		} catch (error) {
			if (error instanceof PayoApiError && error.status === 409) {
				setConflict(true);
				setSubmitError(
					"The config file changed since it was loaded. Your draft is kept below; reload the latest file to replace it with the current version.",
				);
			} else {
				setSubmitError(errorMessage(error, "Could not save settings."));
			}
		} finally {
			setIsSaving(false);
		}
	}

	async function reloadLatest() {
		setIsSaving(true);
		setSubmitError(null);
		try {
			const latest = await getConfigSettings(token);
			setSnapshot(latest);
			setForm(formFromDocument(latest.document));
			setFieldErrors({});
			setSaved(false);
			setConflict(false);
		} catch (error) {
			setSubmitError(errorMessage(error, "Could not reload settings."));
		} finally {
			setIsSaving(false);
		}
	}

	const pageOrigin = window.location.origin;
	const candidatePort =
		integerValue(form.port, 1, 65535) ?? DEFAULT_SERVER_PORT;
	const corsWarning =
		pageOrigin !== `http://127.0.0.1:${candidatePort}` &&
		!originLines(form.webOrigins).includes(pageOrigin)
			? `This page's origin (${pageOrigin}) is not in the allowed web origins. After restart, the browser will be blocked unless you add it.`
			: null;

	return (
		<div className="max-w-4xl space-y-5">
			<section className="console-panel" aria-labelledby="config-file-heading">
				<p className="console-eyebrow text-[10px] font-bold tracking-[0.14em] text-[var(--accent)]">
					CONFIG FILE
				</p>
				<h2 id="config-file-heading" className="mt-1 text-base font-semibold">
					Selected file
				</h2>
				<p className="mt-2 break-all font-mono text-xs text-[var(--muted)]">
					{snapshot.configFile}
				</p>
				<p className="mt-3 text-sm leading-6 text-[var(--muted)]">
					Saving writes this file as canonical TOML and removes comments. Payo
					does not apply changes until you restart the server.
				</p>
				<div className="mt-4 border-t border-[var(--line)] pt-3">
					<h3 className="text-xs font-semibold uppercase tracking-widest">
						Environment overrides
					</h3>
					{snapshot.environmentOverrides.length > 0 ? (
						<>
							<p className="mt-2 text-sm text-[var(--muted)]">
								These variables override saved TOML values until the process
								starts without them:
							</p>
							<ul className="mt-2 flex flex-wrap gap-2">
								{snapshot.environmentOverrides.map((name) => (
									<li
										key={name}
										className="rounded-sm border border-[var(--line)] bg-[var(--surface-raised)] px-2 py-1 font-mono text-xs"
									>
										{name}
									</li>
								))}
							</ul>
						</>
					) : (
						<p className="mt-2 text-sm text-[var(--muted)]">
							No environment variables override this file.
						</p>
					)}
				</div>
				{corsWarning ? (
					<p
						role="status"
						className="mt-4 rounded-sm border border-[var(--warning-border)] bg-[var(--warning-surface)] px-3 py-2.5 text-sm text-[var(--status-warn)]"
					>
						{corsWarning}
					</p>
				) : null}
			</section>

			<form className="space-y-5" noValidate onSubmit={save}>
				<fieldset className="console-panel space-y-4">
					<legend className="px-1 text-sm font-semibold uppercase tracking-widest">
						Server
					</legend>
					<div className="grid gap-4 sm:grid-cols-2">
						<TextField
							id="settings-port"
							label="Server port"
							hint="1..65535. The bind address stays 127.0.0.1. After changing this port, restart Payo and reconnect in the connection screen."
							error={fieldErrors.port}
							type="number"
							min={1}
							max={65535}
							value={form.port}
							onChange={(value) => update("port", value)}
						/>
					</div>
					<TextAreaField
						id="settings-web-origins"
						label="Allowed web origins"
						hint="One exact http(s) loopback origin per line, for example http://127.0.0.1:5173. Empty means only the server's own origin."
						error={fieldErrors.webOrigins}
						value={form.webOrigins}
						onChange={(value) => update("webOrigins", value)}
					/>
				</fieldset>

				<fieldset className="console-panel space-y-4">
					<legend className="px-1 text-sm font-semibold uppercase tracking-widest">
						Paths
					</legend>
					<div className="grid gap-4 sm:grid-cols-2">
						<TextField
							id="settings-data-dir"
							label="Data directory"
							hint="Absolute path. Also selects the database, artifacts, plans, token, sessions and worktrees."
							error={fieldErrors.dataDir}
							value={form.dataDir}
							onChange={(value) => update("dataDir", value)}
						/>
						<TextField
							id="settings-repo"
							label="Repository"
							hint="Absolute path to the target repository. Empty uses the server startup directory."
							error={fieldErrors.repo}
							value={form.repo}
							onChange={(value) => update("repo", value)}
							browseToken={token}
						/>
						<TextField
							id="settings-base-branch"
							label="Base branch"
							hint="Empty uses main."
							error={fieldErrors.baseBranch}
							value={form.baseBranch}
							onChange={(value) => update("baseBranch", value)}
						/>
					</div>
				</fieldset>

				<fieldset className="console-panel space-y-4">
					<legend className="px-1 text-sm font-semibold uppercase tracking-widest">
						Execution and tools
					</legend>
					<div className="grid gap-4 sm:grid-cols-2">
						<TextField
							id="settings-max-concurrent"
							label="Max concurrent agents"
							hint="Positive whole number. Empty uses 4."
							error={fieldErrors.maxConcurrentAgents}
							type="number"
							min={1}
							value={form.maxConcurrentAgents}
							onChange={(value) => update("maxConcurrentAgents", value)}
						/>
						<TextField
							id="settings-pi"
							label="Pi executable"
							hint="Executable name or path. Empty uses pi. Treat this value as a trusted command."
							error={fieldErrors.pi}
							value={form.pi}
							onChange={(value) => update("pi", value)}
						/>
						<TextField
							id="settings-acli"
							label="ACLI executable"
							hint="Executable name or path. Empty uses acli. Treat this value as a trusted command."
							error={fieldErrors.acli}
							value={form.acli}
							onChange={(value) => update("acli", value)}
						/>
						<TextField
							id="settings-git"
							label="Git executable"
							hint="Executable name or path. Empty uses git. Treat this value as a trusted command."
							error={fieldErrors.git}
							value={form.git}
							onChange={(value) => update("git", value)}
						/>
					</div>
				</fieldset>

				<fieldset className="console-panel space-y-4">
					<legend className="px-1 text-sm font-semibold uppercase tracking-widest">
						Global model
					</legend>
					<p className="text-sm leading-6 text-[var(--muted)]">
						Optional default provider and model ID. Neither may contain “/”.
						Leave both blank for the provider default and no model. Real mode
						requires a model for every role.
					</p>
					<div className="grid gap-4 sm:grid-cols-2">
						<TextField
							id="settings-model-provider"
							label="Global provider"
							hint="For example anthropic."
							error={fieldErrors.modelProvider}
							value={form.modelProvider}
							onChange={(value) => update("modelProvider", value)}
						/>
						<TextField
							id="settings-model-id"
							label="Global model ID"
							hint="For example claude-sonnet-4-5."
							error={fieldErrors.modelId}
							value={form.modelId}
							onChange={(value) => update("modelId", value)}
						/>
					</div>
				</fieldset>

				<fieldset className="console-panel space-y-5">
					<legend className="px-1 text-sm font-semibold uppercase tracking-widest">
						Role overrides
					</legend>
					<p className="text-sm leading-6 text-[var(--muted)]">
						Leave a role's provider and model ID blank to inherit the global
						model. A provider/model pair must be complete. Empty timeouts use
						300000 ms.
					</p>
					{ROLES.map((role) => (
						<div
							key={role}
							className="border-t border-[var(--line)] pt-4 first:border-t-0 first:pt-0"
						>
							<h3 className="mb-3 text-sm font-semibold">{roleLabel(role)}</h3>
							<div className="grid gap-4 sm:grid-cols-3">
								<TextField
									id={`settings-role-${role}-provider`}
									label={`${roleLabel(role)} provider`}
									hint="Blank inherits the global provider."
									error={fieldErrors[`role-${role}-provider`]}
									value={form.roles[role].provider}
									onChange={(value) => updateRole(role, "provider", value)}
								/>
								<TextField
									id={`settings-role-${role}-id`}
									label={`${roleLabel(role)} model ID`}
									hint="Blank inherits the global model."
									error={fieldErrors[`role-${role}-id`]}
									value={form.roles[role].id}
									onChange={(value) => updateRole(role, "id", value)}
								/>
								<TextField
									id={`settings-role-${role}-timeout`}
									label={`${roleLabel(role)} timeout (ms)`}
									hint="1..2147483647. Empty uses 300000."
									error={fieldErrors[`role-${role}-timeout`]}
									type="number"
									min={1}
									max={2147483647}
									value={form.roles[role].timeoutMs}
									onChange={(value) => updateRole(role, "timeoutMs", value)}
								/>
							</div>
						</div>
					))}
				</fieldset>

				{saved ? (
					<p
						role="status"
						className="rounded-sm border border-[var(--success-surface)] bg-[var(--success-surface)] px-3 py-2.5 text-sm text-[var(--status-good)]"
					>
						{dirty
							? "Submitted changes saved. Newer edits remain unsaved. Restart Payo to apply the saved settings."
							: "Saved. Restart Payo to apply these settings."}
					</p>
				) : null}

				{submitError ? (
					<div
						role="alert"
						className="rounded-sm border border-[var(--danger-border)] bg-[var(--danger-surface)] px-3 py-2.5 text-sm text-[var(--danger)]"
					>
						<p>{submitError}</p>
						{conflict ? (
							<Button
								className="mt-3"
								size="small"
								type="button"
								variant="secondary"
								disabled={isSaving}
								onClick={() => void reloadLatest()}
							>
								Reload latest
							</Button>
						) : null}
					</div>
				) : null}

				<div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-5">
					<p className="text-xs text-[var(--muted)]">
						Settings are written to the selected file. A restart is required
						before Payo uses them.
					</p>
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							variant="secondary"
							disabled={!dirty || isSaving}
							onClick={discard}
						>
							Discard changes
						</Button>
						<Button type="submit" disabled={isSaving || !dirty}>
							{isSaving ? "Saving…" : "Save settings"}
						</Button>
					</div>
				</div>
			</form>
		</div>
	);
}

const inputClass =
	"min-h-11 w-full rounded-sm border border-[var(--line)] bg-[var(--canvas)] px-3 text-sm outline-none transition placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--focus-ring)]";

function TextField({
	id,
	label,
	hint,
	error,
	value,
	onChange,
	browseToken,
	type = "text",
	min,
	max,
}: {
	id: string;
	label: string;
	hint: string;
	error: string | undefined;
	value: string;
	onChange: (value: string) => void;
	/** When set, shows a native folder picker button. */
	browseToken?: string;
	type?: "text" | "number";
	min?: number;
	max?: number;
}) {
	return (
		<div className="space-y-2">
			<label htmlFor={id} className="block text-sm font-semibold">
				{label}
			</label>
			<div className="flex flex-wrap gap-2">
				<input
					id={id}
					className={`${inputClass} min-w-0 flex-1 ${error ? "border-[var(--danger)]" : ""}`}
					type={type}
					min={min}
					max={max}
					value={value}
					aria-invalid={error ? true : undefined}
					aria-describedby={describedBy(id, hint, error)}
					onChange={(event) => onChange(event.currentTarget.value)}
				/>
				{browseToken ? (
					<BrowseButton token={browseToken} onPick={onChange} />
				) : null}
			</div>
			<p id={`${id}-hint`} className="text-xs text-[var(--muted)]">
				{hint}
			</p>
			{error ? (
				<p id={`${id}-error`} className="text-xs text-[var(--danger)]">
					{error}
				</p>
			) : null}
		</div>
	);
}

function TextAreaField({
	id,
	label,
	hint,
	error,
	value,
	onChange,
}: {
	id: string;
	label: string;
	hint: string;
	error: string | undefined;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="space-y-2">
			<label htmlFor={id} className="block text-sm font-semibold">
				{label}
			</label>
			<textarea
				id={id}
				className={`${inputClass} min-h-24 resize-y py-3 ${error ? "border-[var(--danger)]" : ""}`}
				value={value}
				aria-invalid={error ? true : undefined}
				aria-describedby={describedBy(id, hint, error)}
				onChange={(event) => onChange(event.currentTarget.value)}
			/>
			<p id={`${id}-hint`} className="text-xs text-[var(--muted)]">
				{hint}
			</p>
			{error ? (
				<p id={`${id}-error`} className="text-xs text-[var(--danger)]">
					{error}
				</p>
			) : null}
		</div>
	);
}

function describedBy(id: string, hint: string, error: string | undefined) {
	return [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
		.filter(Boolean)
		.join(" ");
}

function formFromDocument(document: PayoConfigDocument): SettingsForm {
	return {
		port: document.server?.port?.toString() ?? "",
		webOrigins: document.server?.web_origins?.join("\n") ?? "",
		dataDir: document.paths?.data_dir ?? "",
		repo: document.paths?.repo ?? "",
		baseBranch: document.paths?.base_branch ?? "",
		maxConcurrentAgents:
			document.execution?.max_concurrent_agents?.toString() ?? "",
		pi: document.tools?.pi ?? "",
		acli: document.tools?.acli ?? "",
		git: document.tools?.git ?? "",
		modelProvider: document.model?.provider ?? "",
		modelId: document.model?.id ?? "",
		roles: Object.fromEntries(
			ROLES.map((role) => {
				const config = document.roles?.[role];
				return [
					role,
					{
						provider: config?.model?.provider ?? "",
						id: config?.model?.id ?? "",
						timeoutMs: config?.timeout_ms?.toString() ?? "",
					},
				];
			}),
		) as Record<Role, RoleForm>,
		checks: document.execution?.checks ?? [],
		implementer: document.roles?.implementer,
	};
}

function validateForm(form: SettingsForm): {
	document?: PayoConfigDocument;
	errors: Record<string, string>;
} {
	const errors: Record<string, string> = {};
	const numeric = (
		value: string,
		min: number,
		max: number,
		message: string,
	) => {
		if (integerValue(value, min, max) === undefined && value.trim())
			return message;
		return undefined;
	};
	const portError = numeric(
		form.port,
		1,
		65535,
		"Enter a whole number between 1 and 65535.",
	);
	if (portError) errors.port = portError;
	const concurrencyError = numeric(
		form.maxConcurrentAgents,
		1,
		Number.MAX_SAFE_INTEGER,
		"Enter a positive whole number.",
	);
	if (concurrencyError) errors.maxConcurrentAgents = concurrencyError;

	pairErrors(
		form.modelProvider,
		form.modelId,
		"modelProvider",
		"modelId",
		"Complete the provider/model pair or leave both blank.",
		errors,
	);
	for (const role of ROLES) {
		const roleForm = form.roles[role];
		const timeoutError = numeric(
			roleForm.timeoutMs,
			1,
			2147483647,
			"Enter a whole number between 1 and 2147483647.",
		);
		if (timeoutError) errors[`role-${role}-timeout`] = timeoutError;
		pairErrors(
			roleForm.provider,
			roleForm.id,
			`role-${role}-provider`,
			`role-${role}-id`,
			"Complete the provider/model pair or leave both blank to inherit.",
			errors,
		);
	}

	const candidate = buildCandidate(form);
	const parsed = PayoConfigDocumentSchema.safeParse(candidate);
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			const field = fieldForIssue(issue.path);
			if (field) errors[field] ??= issue.message;
			else errors.form = "Check the settings values.";
		}
	}
	if (Object.keys(errors).length > 0) return { errors };
	return { document: parsed.success ? parsed.data : candidate, errors };
}

function buildCandidate(form: SettingsForm): PayoConfigDocument {
	const candidate: PayoConfigDocument = {};
	const port = integerValue(form.port, 1, 65535);
	const origins = originLines(form.webOrigins);
	if (port !== undefined || origins.length > 0)
		candidate.server = {
			...(port === undefined ? {} : { port }),
			...(origins.length === 0 ? {} : { web_origins: origins }),
		};

	const dataDir = form.dataDir.trim();
	const repo = form.repo.trim();
	const baseBranch = form.baseBranch.trim();
	if (dataDir || repo || baseBranch)
		candidate.paths = {
			...(dataDir ? { data_dir: dataDir } : {}),
			...(repo ? { repo } : {}),
			...(baseBranch ? { base_branch: baseBranch } : {}),
		};

	const maxConcurrentAgents = integerValue(
		form.maxConcurrentAgents,
		1,
		Number.MAX_SAFE_INTEGER,
	);
	if (maxConcurrentAgents !== undefined || form.checks.length > 0)
		candidate.execution = {
			...(maxConcurrentAgents === undefined
				? {}
				: { max_concurrent_agents: maxConcurrentAgents }),
			...(form.checks.length === 0 ? {} : { checks: form.checks }),
		};

	const pi = form.pi.trim();
	const acli = form.acli.trim();
	const git = form.git.trim();
	if (pi || acli || git)
		candidate.tools = {
			...(pi ? { pi } : {}),
			...(acli ? { acli } : {}),
			...(git ? { git } : {}),
		};

	const model = pairValue(form.modelProvider, form.modelId);
	if (model) candidate.model = model;

	const roles: NonNullable<PayoConfigDocument["roles"]> = {};
	for (const role of ROLES) {
		const roleForm = form.roles[role];
		const roleModel = pairValue(roleForm.provider, roleForm.id);
		const timeoutMs = integerValue(roleForm.timeoutMs, 1, 2147483647);
		if (roleModel || timeoutMs !== undefined)
			roles[role] = {
				...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
				...(roleModel === undefined ? {} : { model: roleModel }),
			};
	}
	if (Object.keys(roles).length > 0) candidate.roles = roles;
	if (form.implementer !== undefined)
		candidate.roles = { ...candidate.roles, implementer: form.implementer };
	return candidate;
}

function pairValue(provider: string, id: string) {
	const trimmedProvider = provider.trim();
	const trimmedId = id.trim();
	return trimmedProvider && trimmedId
		? { provider: trimmedProvider, id: trimmedId }
		: undefined;
}

function pairErrors(
	provider: string,
	id: string,
	providerKey: string,
	idKey: string,
	message: string,
	errors: Record<string, string>,
) {
	const trimmedProvider = provider.trim();
	const trimmedId = id.trim();
	if (!trimmedProvider && !trimmedId) return;
	if (!trimmedProvider) errors[providerKey] = message;
	else if (!trimmedId) errors[idKey] = message;
}

function integerValue(value: string, min: number, max: number) {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const parsed = Number(trimmed);
	return Number.isInteger(parsed) && parsed >= min && parsed <= max
		? parsed
		: undefined;
}

function originLines(value: string): string[] {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function fieldForIssue(path: readonly PropertyKey[]): string | undefined {
	const key = path.map(String).join(".");
	if (key === "server.port") return "port";
	if (key.startsWith("server.web_origins")) return "webOrigins";
	if (key === "paths.data_dir") return "dataDir";
	if (key === "paths.repo") return "repo";
	if (key === "paths.base_branch") return "baseBranch";
	if (key === "execution.max_concurrent_agents") return "maxConcurrentAgents";
	if (key === "tools.pi") return "pi";
	if (key === "tools.acli") return "acli";
	if (key === "tools.git") return "git";
	if (key === "model.provider") return "modelProvider";
	if (key === "model.id") return "modelId";
	const role = /^roles\.([a-z]+)\.(timeout_ms|model\.(provider|id))$/.exec(key);
	if (!role) return undefined;
	const roleName = role[1];
	const field = role[2];
	if (!roleName || !field) return undefined;
	if (field === "timeout_ms") return `role-${roleName}-timeout`;
	return `role-${roleName}-${field.endsWith("provider") ? "provider" : "id"}`;
}

function roleLabel(role: Role) {
	return role.charAt(0).toUpperCase() + role.slice(1);
}

function errorMessage(error: unknown, fallback: string) {
	return error instanceof Error && error.message ? error.message : fallback;
}
