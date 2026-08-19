import {
  ArrowLeftIcon as BlueprintArrowLeftIcon,
  ChevronLeftIcon as BlueprintChevronLeftIcon,
  ChevronRightIcon as BlueprintChevronRightIcon,
  CrossIcon as BlueprintCrossIcon,
  DoubleCaretVerticalIcon as BlueprintDoubleCaretVerticalIcon,
  DuplicateIcon as BlueprintDuplicateIcon,
  GlobeNetworkIcon as BlueprintGlobeNetworkIcon,
  KeyIcon as BlueprintKeyIcon,
  PathSearchIcon as BlueprintPathSearchIcon,
  PlusIcon as BlueprintPlusIcon,
  PolygonFilterIcon as BlueprintPolygonFilterIcon,
  SatelliteIcon as BlueprintSatelliteIcon,
  SearchIcon as BlueprintSearchIcon,
  SendToGraphIcon as BlueprintSendToGraphIcon,
  TrashIcon as BlueprintTrashIcon
} from "@blueprintjs/icons";
import type { CSSProperties } from "react";

type IconProps = {
  size?: number;
  className?: string;
  style?: CSSProperties;
};

export function AssetsIcon(props: IconProps) {
  return <BlueprintSatelliteIcon {...props} />;
}

export function TracksIcon(props: IconProps) {
  return <BlueprintPathSearchIcon {...props} />;
}

export function GeofeaturesIcon(props: IconProps) {
  return <BlueprintPolygonFilterIcon {...props} />;
}

export function CommandsIcon(props: IconProps) {
  return <BlueprintSendToGraphIcon {...props} />;
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

export function DoubleCaretVerticalIcon(props: IconProps) {
  return <BlueprintDoubleCaretVerticalIcon {...props} />;
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
