import { haversineMetres } from './geo';
import type { Coordinate } from './types';

export type RouteMetrics = {
  cumulativeMetres: number[];
  totalMetres: number;
};

export type RouteProjection = {
  coordinate: Coordinate;
  segmentIndex: number;
  fraction: number;
  shapePosition: number;
  distanceFromRouteMetres: number;
  distanceAlongRouteMetres: number;
  routeHeading: number;
};

export function buildRouteMetrics(route: Coordinate[]): RouteMetrics {
  const cumulativeMetres = [0];
  let totalMetres = 0;
  for (let index = 1; index < route.length; index += 1) {
    totalMetres += haversineMetres(route[index - 1]!, route[index]!);
    cumulativeMetres.push(totalMetres);
  }
  return { cumulativeMetres, totalMetres };
}

export function projectOnRoute(
  position: Coordinate,
  route: Coordinate[],
  metrics = buildRouteMetrics(route),
  previousDistanceAlongMetres?: number,
): RouteProjection | null {
  if (route.length < 2) return null;

  let best: RouteProjection | null = null;
  const latitudeScale = 111_320;
  const longitudeScale = Math.max(1, Math.cos((position.latitude * Math.PI) / 180) * 111_320);
  for (let index = 0; index < route.length - 1; index += 1) {
    const from = route[index]!;
    const to = route[index + 1]!;
    const ax = (from.longitude - position.longitude) * longitudeScale;
    const ay = (from.latitude - position.latitude) * latitudeScale;
    const bx = (to.longitude - position.longitude) * longitudeScale;
    const by = (to.latitude - position.latitude) * latitudeScale;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared > 0 ? clamp(-(ax * dx + ay * dy) / lengthSquared, 0, 1) : 0;
    const coordinate = {
      latitude: from.latitude + (to.latitude - from.latitude) * fraction,
      longitude: from.longitude + (to.longitude - from.longitude) * fraction,
    };
    const distanceFromRouteMetres = haversineMetres(position, coordinate);
    const segmentLength = (metrics.cumulativeMetres[index + 1] ?? 0) - (metrics.cumulativeMetres[index] ?? 0);
    const distanceAlongRouteMetres = (metrics.cumulativeMetres[index] ?? 0) + segmentLength * fraction;

    // At crossings and parallel service roads, prefer a nearby forward
    // projection. This stops the blue route from jumping kilometres ahead or
    // backwards while still allowing a genuine reroute to reset progress.
    const continuityPenalty = previousDistanceAlongMetres == null
      ? 0
      : Math.max(0, previousDistanceAlongMetres - distanceAlongRouteMetres - 35) * 2
        + Math.max(0, distanceAlongRouteMetres - previousDistanceAlongMetres - 1_500) * 0.15;
    const score = distanceFromRouteMetres + continuityPenalty;
    const currentScore = best
      ? best.distanceFromRouteMetres + (previousDistanceAlongMetres == null ? 0
        : Math.max(0, previousDistanceAlongMetres - best.distanceAlongRouteMetres - 35) * 2
          + Math.max(0, best.distanceAlongRouteMetres - previousDistanceAlongMetres - 1_500) * 0.15)
      : Number.POSITIVE_INFINITY;
    if (score < currentScore) {
      best = {
        coordinate,
        segmentIndex: index,
        fraction,
        shapePosition: index + fraction,
        distanceFromRouteMetres,
        distanceAlongRouteMetres,
        routeHeading: bearing(from, to),
      };
    }
  }
  return best;
}

export function remainingRoute(route: Coordinate[], projection: RouteProjection | null): Coordinate[] {
  if (!projection) return route;
  return [projection.coordinate, ...route.slice(projection.segmentIndex + 1)];
}

export function headingDifference(left: number, right: number): number {
  return Math.abs(((left - right + 540) % 360) - 180);
}

function bearing(from: Coordinate, to: Coordinate): number {
  const fromLat = from.latitude * Math.PI / 180;
  const toLat = to.latitude * Math.PI / 180;
  const deltaLon = (to.longitude - from.longitude) * Math.PI / 180;
  const y = Math.sin(deltaLon) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
