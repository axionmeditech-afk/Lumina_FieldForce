import { validCoordinates } from "./geofence";

export function isUsableLocationSample(sample: { timestamp: number; mocked?: boolean; coords: { latitude: number; longitude: number; accuracy: number | null; mocked?: boolean } }, now = Date.now(), maxAccuracy = 120): boolean {
  return validCoordinates(sample.coords.latitude, sample.coords.longitude) &&
    !sample.mocked && !sample.coords.mocked && Number.isFinite(sample.timestamp) &&
    now - sample.timestamp >= -5000 && now - sample.timestamp <= 20_000 &&
    typeof sample.coords.accuracy === "number" && Number.isFinite(sample.coords.accuracy) &&
    sample.coords.accuracy > 0 && sample.coords.accuracy <= maxAccuracy;
}
