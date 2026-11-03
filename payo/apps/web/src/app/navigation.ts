import { RunId } from "@payo/contracts";
import { useEffect, useRef, useState } from "react";

const DISCARD_PROMPT = "Discard unsaved settings changes?";

export function useRunNavigation({
	isDirty = false,
	onDiscard = () => {},
}: {
	isDirty?: boolean;
	onDiscard?: () => void;
} = {}) {
	const [pathname, setPathname] = useState(() => window.location.pathname);
	const pathnameRef = useRef(pathname);
	const dirtyRef = useRef(isDirty);
	const discardRef = useRef(onDiscard);
	pathnameRef.current = pathname;
	dirtyRef.current = isDirty;
	discardRef.current = onDiscard;

	useEffect(() => {
		const syncPath = () => {
			if (dirtyRef.current && !window.confirm(DISCARD_PROMPT)) {
				window.history.pushState({}, "", pathnameRef.current);
				return;
			}
			discardRef.current();
			setPathname(window.location.pathname);
		};
		window.addEventListener("popstate", syncPath);
		return () => window.removeEventListener("popstate", syncPath);
	}, []);

	function navigate(path: string) {
		if (path === pathnameRef.current) return;
		if (dirtyRef.current && !window.confirm(DISCARD_PROMPT)) return;
		discardRef.current();
		window.history.pushState({}, "", path);
		setPathname(path);
	}

	const runPathId =
		pathname === "/runs/new"
			? null
			: (/^\/runs\/([^/]+)\/?$/.exec(pathname)?.[1] ?? null);
	const selectedRunId =
		runPathId && RunId.safeParse(runPathId).success ? runPathId : null;

	return {
		page:
			pathname === "/server"
				? "server"
				: pathname === "/settings"
					? "settings"
					: "new-run",
		selectedRunId,
		invalidRunRoute: runPathId !== null && selectedRunId === null,
		navigateHome: () => navigate("/"),
		navigateServer: () => navigate("/server"),
		navigateSettings: () => navigate("/settings"),
		navigateNewRun: () => navigate("/runs/new"),
		navigateToRun: (runId: string) => navigate(`/runs/${runId}`),
	};
}
