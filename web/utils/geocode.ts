"use client";

// Turn a typed address into coordinates so listings power distance search,
// instead of asking owners to enter lat/lng by hand. Uses OpenStreetMap's
// Nominatim — free and key-less, which suits a low-volume friends app. Swap the
// endpoint for Google/Mapbox later if volume or precision demands it.

export type GeocodeResult = {
  label: string; // the provider's formatted display name
  lat: number;
  lng: number;
};

const ENDPOINT = "https://nominatim.openstreetmap.org/search";

type NominatimHit = {
  lat: string;
  lon: string;
  display_name: string;
};

// Up to a handful of candidate matches for an address, so the owner can pick
// the right one. Nominatim discourages as-you-type autocomplete (rate limits),
// so call this on an explicit search (button / Enter), not every keystroke.
export async function geocodeMatches(
  address: string,
): Promise<GeocodeResult[]> {
  const query = address.trim();
  if (!query) return [];
  const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&format=jsonv2&limit=5`;
  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    const hits = (await response.json()) as NominatimHit[];
    return hits.map((hit) => ({
      label: hit.display_name,
      lat: Number(hit.lat),
      lng: Number(hit.lon),
    }));
  } catch (error) {
    console.error("geocode", error);
    return [];
  }
}

export async function geocodeAddress(
  address: string,
): Promise<GeocodeResult | null> {
  return (await geocodeMatches(address))[0] ?? null;
}
