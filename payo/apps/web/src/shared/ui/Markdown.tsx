import { createElement } from "react";
import ReactMarkdown, {
	type Components,
	defaultUrlTransform,
} from "react-markdown";

function safeMarkdownUrl(url: string, key: string): string {
	const transformed = defaultUrlTransform(url);
	if (!transformed || key === "src" || url.startsWith("//")) return "";
	const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url)?.[1]?.toLowerCase();
	if (scheme && !["http", "https", "mailto"].includes(scheme)) return "";
	return transformed;
}

const anchoredHeading: NonNullable<Components["h1"]> = ({ node, children }) => {
	const line = node?.position?.start.line;
	return createElement(
		node?.tagName ?? "h2",
		{ id: line ? `plan-line-${line}` : undefined },
		children,
	);
};
const headingComponents = {
	h1: anchoredHeading,
	h2: anchoredHeading,
	h3: anchoredHeading,
	h4: anchoredHeading,
	h5: anchoredHeading,
	h6: anchoredHeading,
};

export function Markdown({
	children,
	headingAnchors = false,
}: {
	children: string;
	headingAnchors?: boolean;
}) {
	return (
		<div className="plan-markdown">
			<ReactMarkdown
				skipHtml
				urlTransform={safeMarkdownUrl}
				components={{
					...(headingAnchors ? headingComponents : {}),
					a: ({ node: _node, href, children: linkChildren, ...props }) =>
						href ? (
							<a
								{...props}
								href={href}
								rel="noopener noreferrer"
								target="_blank"
							>
								{linkChildren}
							</a>
						) : (
							<span>{linkChildren}</span>
						),
					img: () => null,
				}}
			>
				{children}
			</ReactMarkdown>
		</div>
	);
}
