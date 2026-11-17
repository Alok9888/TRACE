import type { SVGProps } from "react";

import { cn } from "@/lib/utils";

type TraceIconProps = SVGProps<SVGSVGElement> & {
  variant?: "color" | "mono";
};

export function TraceIcon({
  className,
  variant = "color",
  ...props
}: TraceIconProps) {
  const mono = variant === "mono";

  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("shrink-0", className)}
      {...props}
    >
      <rect
        x="1.5"
        y="1.5"
        width="61"
        height="61"
        rx="2"
        fill={mono ? "currentColor" : "var(--background)"}
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M18 24l11 8-11 8"
        stroke={mono ? "var(--background)" : "currentColor"}
        strokeWidth="3"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <path
        d="M34 40h13"
        stroke={mono ? "var(--background)" : "currentColor"}
        strokeWidth="3"
        strokeLinecap="square"
      />
    </svg>
  );
}
