import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleDashed } from "@phosphor-icons/react/CircleDashed";
import { SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import type { WorkflowStatus } from "../types";

export function StatusIcon({ status, size = 18 }: { status: WorkflowStatus; size?: number }) {
  if (status === "complete") return <CheckCircle aria-hidden size={size} weight="fill" />;
  if (status === "active") return <SpinnerGap aria-hidden className="spin" size={size} weight="bold" />;
  if (status === "attention") return <WarningCircle aria-hidden size={size} weight="fill" />;
  return <CircleDashed aria-hidden size={size} weight="bold" />;
}
