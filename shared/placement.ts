export const DO_LOCATION_HINT_BINDING = "DO_LOCATION_HINT";

type LongitudeRange = Readonly<{
  minimum?: number;
  maximum?: number;
}>;

interface PlacementRegionDefinition {
  readonly label: string;
  readonly code: string;
  readonly containerRegions: readonly string[];
  readonly inference: Readonly<{
    continent: string;
    longitude?: LongitudeRange;
  }>;
}

function definition(value: PlacementRegionDefinition): PlacementRegionDefinition {
  Object.freeze(value.containerRegions);
  if (value.inference.longitude) Object.freeze(value.inference.longitude);
  Object.freeze(value.inference);
  return Object.freeze(value);
}

/**
 * The single placement registry used by the installer, Hub runtime, and UI.
 * Longitude minima are inclusive; maxima are exclusive.
 */
export const PLACEMENT_REGISTRY = Object.freeze({
  wnam: definition({
    label: "Western North America",
    code: "WNAM",
    containerRegions: ["WNAM"],
    inference: { continent: "NA", longitude: { maximum: -100 } },
  }),
  enam: definition({
    label: "Eastern North America",
    code: "ENAM",
    containerRegions: ["ENAM"],
    inference: { continent: "NA", longitude: { minimum: -100 } },
  }),
  sam: definition({
    label: "South America",
    code: "SAM",
    containerRegions: ["SAM"],
    inference: { continent: "SA" },
  }),
  weur: definition({
    label: "Western Europe",
    code: "WEUR",
    containerRegions: ["WEUR"],
    inference: { continent: "EU", longitude: { maximum: 15 } },
  }),
  eeur: definition({
    label: "Eastern Europe",
    code: "EEUR",
    containerRegions: ["EEUR"],
    inference: { continent: "EU", longitude: { minimum: 15 } },
  }),
  apac: definition({
    label: "Asia Pacific",
    code: "APAC",
    containerRegions: ["APAC"],
    inference: { continent: "AS", longitude: { minimum: 60 } },
  }),
  me: definition({
    label: "Middle East",
    code: "ME",
    containerRegions: ["ME", "EEUR"],
    inference: { continent: "AS", longitude: { maximum: 60 } },
  }),
  afr: definition({
    label: "Africa",
    code: "AFR",
    containerRegions: ["AFR", "WEUR"],
    inference: { continent: "AF" },
  }),
  oc: definition({
    label: "Oceania",
    code: "OC",
    containerRegions: ["OC", "APAC"],
    inference: { continent: "OC" },
  }),
} as const);

export type PlacementRegion = keyof typeof PLACEMENT_REGISTRY;

export const PLACEMENT_REGIONS = Object.freeze(
  Object.keys(PLACEMENT_REGISTRY) as PlacementRegion[],
);

export function isPlacementRegion(value: unknown): value is PlacementRegion {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(PLACEMENT_REGISTRY, value);
}

export function placementRegionDefinition(
  region: PlacementRegion,
): (typeof PLACEMENT_REGISTRY)[PlacementRegion] {
  return PLACEMENT_REGISTRY[region];
}

function requestLongitude(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const longitude = Number(value);
  return Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
    ? longitude
    : null;
}

export function inferPlacementRegion(value: unknown): PlacementRegion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (typeof request.continent !== "string") return null;
  const continent = request.continent.toUpperCase();
  const candidates = PLACEMENT_REGIONS.filter((region) => (
    PLACEMENT_REGISTRY[region].inference.continent === continent
  ));
  if (candidates.length === 0) return null;
  if (candidates.every((region) => PLACEMENT_REGISTRY[region].inference.longitude === undefined)) {
    return candidates.length === 1 ? candidates[0] : null;
  }

  const longitude = requestLongitude(request.longitude);
  if (longitude === null) return null;
  return candidates.find((region) => {
    const range = PLACEMENT_REGISTRY[region].inference.longitude;
    if (!range) return false;
    return (range.minimum === undefined || longitude >= range.minimum)
      && (range.maximum === undefined || longitude < range.maximum);
  }) ?? null;
}
