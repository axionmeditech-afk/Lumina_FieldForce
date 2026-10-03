import type { Coordinate, RoutePoint } from './types';

export function haversineMetres(a: Coordinate, b: Coordinate): number {
  const radius = 6_371_000;
  const radians = (value: number) => value * Math.PI / 180;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const latitudeA = radians(a.latitude);
  const latitudeB = radians(b.latitude);
  const h = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function routeDistance(points: RoutePoint[]): number {
  const eligible = points.filter((point) => point.routeEligible);
  let total = 0;
  for (let index = 1; index < eligible.length; index += 1) {
    total += haversineMetres(eligible[index - 1]!, eligible[index]!);
  }
  return total;
}

export function distanceToRoute(point: Coordinate, route: Coordinate[]): number {
  if (!route.length) return Number.POSITIVE_INFINITY;
  if (route.length === 1) return haversineMetres(point, route[0]!);
  let nearest = Number.POSITIVE_INFINITY;
  const longitudeScale = Math.max(0.1, Math.cos(point.latitude * Math.PI / 180));
  for (let index = 1; index < route.length; index += 1) {
    const from = route[index - 1]!;
    const to = route[index]!;
    const x = (point.longitude - from.longitude) * longitudeScale;
    const y = point.latitude - from.latitude;
    const dx = (to.longitude - from.longitude) * longitudeScale;
    const dy = to.latitude - from.latitude;
    const length = dx * dx + dy * dy;
    const fraction = length > 0 ? Math.max(0, Math.min(1, (x * dx + y * dy) / length)) : 0;
    const candidate = {
      latitude: from.latitude + (to.latitude - from.latitude) * fraction,
      longitude: from.longitude + (to.longitude - from.longitude) * fraction,
    };
    nearest = Math.min(nearest, haversineMetres(point, candidate));
  }
  return nearest;
}

export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres)) return '--';
  if (metres < 1_000) return `${Math.max(0, Math.round(metres))} m`;
  return `${(metres / 1_000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}
