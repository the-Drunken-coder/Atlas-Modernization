import {
  ArrowLeftIcon as BlueprintArrowLeftIcon,
  ChevronLeftIcon as BlueprintChevronLeftIcon,
  ChevronRightIcon as BlueprintChevronRightIcon,
  CrossIcon as BlueprintCrossIcon,
  CubeIcon as BlueprintCubeIcon,
  DetectionIcon as BlueprintDetectionIcon,
  DoubleCaretVerticalIcon as BlueprintDoubleCaretVerticalIcon,
  DuplicateIcon as BlueprintDuplicateIcon,
  GlobeNetworkIcon as BlueprintGlobeNetworkIcon,
  KeyIcon as BlueprintKeyIcon,
  PlayIcon as BlueprintPlayIcon,
  PlusIcon as BlueprintPlusIcon,
  PolygonFilterIcon as BlueprintPolygonFilterIcon,
  SearchIcon as BlueprintSearchIcon,
  SelectionIcon as BlueprintSelectionIcon,
  TickIcon as BlueprintTickIcon,
  TrashIcon as BlueprintTrashIcon
} from "@blueprintjs/icons";
import type { CSSProperties } from "react";

type IconProps = {
  size?: number;
  className?: string;
  style?: CSSProperties;
};

export function AssetsIcon(props: IconProps) {
  return <BlueprintCubeIcon {...props} />;
}

export function TracksIcon(props: IconProps) {
  return <BlueprintDetectionIcon {...props} />;
}

export function GeofeaturesIcon(props: IconProps) {
  return <BlueprintPolygonFilterIcon {...props} />;
}

export function CommandsIcon(props: IconProps) {
  return <BlueprintPlayIcon {...props} />;
}

export function KeyIcon(props: IconProps) {
  return <BlueprintKeyIcon {...props} />;
}

export function BrandIcon(props: IconProps) {
  return <BlueprintGlobeNetworkIcon {...props} />;
}

export function BackIcon(props: IconProps) {
  return <BlueprintArrowLeftIcon {...props} />;
}

export function CollapseIcon(props: IconProps) {
  return <BlueprintChevronLeftIcon {...props} />;
}

export function ChevronRightIcon(props: IconProps) {
  return <BlueprintChevronRightIcon {...props} />;
}

export function SearchIcon(props: IconProps) {
  return <BlueprintSearchIcon {...props} />;
}

export function ComparisonIcon(props: IconProps) {
  return <BlueprintSelectionIcon {...props} />;
}

export function DoubleCaretVerticalIcon(props: IconProps) {
  return <BlueprintDoubleCaretVerticalIcon {...props} />;
}

export function TickIcon(props: IconProps) {
  return <BlueprintTickIcon {...props} />;
}

export function CopyIcon(props: IconProps) {
  return <BlueprintDuplicateIcon {...props} />;
}

export function CloseIcon(props: IconProps) {
  return <BlueprintCrossIcon {...props} />;
}

export function PlusIcon(props: IconProps) {
  return <BlueprintPlusIcon {...props} />;
}

export function TrashIcon(props: IconProps) {
  return <BlueprintTrashIcon {...props} />;
}
