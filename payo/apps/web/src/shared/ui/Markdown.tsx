import ReactMarkdown, { defaultUrlTransform } from "react-markdown";

function safeMarkdownUrl(url: string, key: string): string {
	const transformed = defaultUrlTransform(url);
	if (!transformed || key === "src" || url.startsWith("//")) return "";
	const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url)?.[1]?.toLowerCase();
	if (scheme && !["http", "https", "mailto"].includes(scheme)) return "";
	return transformed;
}

export function Markdown({ children }: { children: string }) {
	return (
		<div className="plan-markdown">
			<ReactMarkdown
				skipHtml
				urlTransform={safeMarkdownUrl}
				components={{
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
