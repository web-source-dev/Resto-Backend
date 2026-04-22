import axios from "axios";
import { env } from "../../config/env";

export function mapsConfigured() {
  return Boolean(env.GOOGLE_MAPS_KEY);
}

export async function geocode(address: string) {
  if (!env.GOOGLE_MAPS_KEY) {
    return {
      ok: true as const,
      provider: "mock" as const,
      lat: 24.8607,
      lng: 67.0011,
      formatted: address,
    };
  }
  try {
    const r = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address, key: env.GOOGLE_MAPS_KEY },
      timeout: 6000,
    });
    const first = r.data?.results?.[0];
    if (!first) return { ok: false as const, error: "No results" };
    return {
      ok: true as const,
      provider: "google" as const,
      lat: first.geometry.location.lat,
      lng: first.geometry.location.lng,
      formatted: first.formatted_address,
    };
  } catch (err: any) {
    return { ok: false as const, error: err?.message ?? String(err) };
  }
}

export async function distanceKm(origin: string, destination: string) {
  if (!env.GOOGLE_MAPS_KEY) {
    return { ok: true as const, provider: "mock" as const, km: 3.2, durationMin: 12 };
  }
  try {
    const r = await axios.get(
      "https://maps.googleapis.com/maps/api/distancematrix/json",
      {
        params: { origins: origin, destinations: destination, key: env.GOOGLE_MAPS_KEY },
        timeout: 6000,
      }
    );
    const el = r.data?.rows?.[0]?.elements?.[0];
    if (!el || el.status !== "OK") return { ok: false as const, error: el?.status ?? "Failed" };
    return {
      ok: true as const,
      provider: "google" as const,
      km: el.distance.value / 1000,
      durationMin: Math.round(el.duration.value / 60),
    };
  } catch (err: any) {
    return { ok: false as const, error: err?.message ?? String(err) };
  }
}
