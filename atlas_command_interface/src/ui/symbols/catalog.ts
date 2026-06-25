import type { RenderSymbolOptions } from "sidc-kit";

export type SymbolStyleOptions = Omit<RenderSymbolOptions, "size">;

export type SymbolConfig = {
  sidc: string;
  size?: number;
  options?: SymbolStyleOptions;
};

export const DEFAULT_SYMBOL_CATALOG = {
  DRONE: { sidc: "130301000011030000100100000000", size: 35, options: { fill: true, frame: true } },
  SENSOR: { sidc: "130315000022010000000000000000", size: 35, options: { fill: true, frame: true } },
  SIGNAL: { sidc: "130152000011010000000000000000", size: 35, options: { fill: true, frame: true } },
  SENTRY: { sidc: "130315000022020025001000000000", size: 35, options: { fill: true, frame: true } },
  DEBUG: { sidc: "130110000000000000000000000000", size: 35, options: { fill: true, frame: true } },
  PERSON: { sidc: "130511000011030000000000000000", size: 35, options: { fill: true, frame: true } },
  DOG: { sidc: "130510000014050000000000000000", size: 35, options: { fill: true, frame: true } },
  CAR: { sidc: "130515000016010000000000000000", size: 35, options: { fill: true, frame: true } },
  ROVER: { sidc: "130310000012130001101100000000", size: 35, options: { fill: true, frame: true } },
  SERVER: { sidc: "130360000017010025001000000000", size: 35, options: { fill: true, frame: true } }
} satisfies Record<string, SymbolConfig>;

export type SymbolCatalogKey = keyof typeof DEFAULT_SYMBOL_CATALOG;

export const DEFAULT_SYMBOL_TYPE_MAPPING: Record<string, SymbolCatalogKey> = {
  drone: "DRONE",
  uav: "DRONE",
  uas: "DRONE",
  quadrotor: "DRONE",
  rover: "ROVER",
  ground_rover: "ROVER",
  ugv: "ROVER",
  sensor: "SENSOR",
  signal: "SIGNAL",
  relay: "SIGNAL",
  sentry: "SENTRY",
  tower: "SENTRY",
  person: "PERSON",
  pedestrian: "PERSON",
  human: "PERSON",
  team: "PERSON",
  dog: "DOG",
  k9: "DOG",
  canine: "DOG",
  car: "CAR",
  vehicle: "CAR",
  truck: "CAR",
  suv: "CAR",
  server: "SERVER",
  debug: "DEBUG",
  default: "DEBUG"
};

export const DEFAULT_SYMBOL_FALLBACK: Required<SymbolConfig> = {
  sidc: DEFAULT_SYMBOL_CATALOG.DEBUG.sidc,
  size: 35,
  options: { fill: true, frame: true }
};
