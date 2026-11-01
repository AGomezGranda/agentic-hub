import { cva, type VariantProps } from "class-variance-authority";
import clsx, { type ClassValue } from "clsx";
import type { ComponentProps } from "react";
import { twMerge } from "tailwind-merge";

export function cn(...values: ClassValue[]): string {
	return twMerge(clsx(values));
}

const buttonStyles = cva(
	"inline-flex items-center justify-center gap-2 rounded-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				primary:
					"bg-[var(--accent)] text-[var(--accent-ink)] hover:bg-[var(--accent-strong)]",
				secondary:
					"border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--surface-raised)]",
				quiet:
					"text-[var(--muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]",
			},
			size: {
				default: "min-h-11 px-4 text-sm",
				small: "min-h-9 px-3 text-xs",
			},
		},
		defaultVariants: { variant: "primary", size: "default" },
	},
);

type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonStyles>;

export function Button({ className, size, variant, ...props }: ButtonProps) {
	return (
		<button
			className={cn(buttonStyles({ size, variant }), className)}
			{...props}
		/>
	);
}
