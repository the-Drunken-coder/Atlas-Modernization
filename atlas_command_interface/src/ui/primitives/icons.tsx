import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function AssetsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l8 16H4l8-16z" />
      <circle cx="12" cy="14" r="1.4" />
    </Svg>
  );
}

export function TracksIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l9 9-9 9-9-9 9-9z" />
    </Svg>
  );
}

export function GeofeaturesIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7l7-3 9 4-2 11-9 2-5-4 0-10z" />
    </Svg>
  );
}

export function CommandsIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M5 7l4 4-4 4" />
			<path d="M12 16h7" />
    </Svg>
	);
}

export function KeyIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<circle cx="7.5" cy="12" r="3.5" />
			<path d="M11 12h9M16 12v3M19 12v-3" />
		</Svg>
	);
}

export function BrandIcon(props: IconProps) {
	return (
		<Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17M3.5 12h17" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function BackIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 6l-6 6 6 6" />
    </Svg>
  );
}

export function CollapseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 6l-6 6 6 6" />
      <path d="M19 6v12" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
    </Svg>
  );
}

export function TargetIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </Svg>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 6l6 6-6 6" />
    </Svg>
  );
}
