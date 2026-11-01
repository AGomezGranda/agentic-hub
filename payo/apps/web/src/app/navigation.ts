import { RunId } from "@payo/contracts";
import { useEffect, useState } from "react";

export function useRunNavigation() {
	const [pathname, setPathname] = useState(() => window.location.pathname);
	useEffect(() => {
		const syncPath = () => setPathname(window.location.pathname);
		window.addEventListener("popstate", syncPath);
		return () => window.removeEventListener("popstate", syncPath);
	}, []);

	function navigate(path: string) {
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
		page: pathname === "/server" ? "server" : "new-run",
		selectedRunId,
		invalidRunRoute: runPathId !== null && selectedRunId === null,
		navigateHome: () => navigate("/"),
		navigateServer: () => navigate("/server"),
		navigateNewRun: () => navigate("/runs/new"),
		navigateToRun: (runId: string) => navigate(`/runs/${runId}`),
	};
}
