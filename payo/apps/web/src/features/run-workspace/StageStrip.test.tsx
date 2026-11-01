import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { StageStrip } from "./StageStrip.tsx";

afterEach(cleanup);

it("displays an unknown stage from the public summary without hiding it", () => {
	render(<StageStrip stage="FutureServerStage" />);
	expect(screen.getByLabelText("Current stage")).toHaveTextContent(
		"FutureServerStage",
	);
});
