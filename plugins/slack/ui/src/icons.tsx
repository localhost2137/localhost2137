import type { PropsWithChildren, SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function Icon({ children, className, ...props }: PropsWithChildren<IconProps>) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			fill="none"
			focusable="false"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="1.8"
			viewBox="0 0 24 24"
			{...props}
		>
			{children}
		</svg>
	);
}

export function ChevronDownIcon(props: IconProps) {
	return (
		<Icon {...props}>
			<path d="m7 10 5 5 5-5" />
		</Icon>
	);
}

export function CloseIcon(props: IconProps) {
	return (
		<Icon {...props}>
			<path d="m6 6 12 12M18 6 6 18" />
		</Icon>
	);
}

export function HashIcon(props: IconProps) {
	return (
		<Icon {...props}>
			<path d="M10 3 8 21M16 3l-2 18M4 9h16M3 15h16" />
		</Icon>
	);
}

export function LockIcon(props: IconProps) {
	return (
		<Icon {...props}>
			<rect height="10" rx="2" width="14" x="5" y="10" />
			<path d="M8 10V7a4 4 0 0 1 8 0v3" />
		</Icon>
	);
}

export function MenuIcon(props: IconProps) {
	return (
		<Icon {...props}>
			<path d="M4 7h16M4 12h16M4 17h16" />
		</Icon>
	);
}

export function PlusIcon(props: IconProps) {
	return (
		<Icon {...props}>
			<path d="M12 5v14M5 12h14" />
		</Icon>
	);
}
