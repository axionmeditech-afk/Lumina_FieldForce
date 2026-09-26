
import MapView, { Circle, Marker } from "react-native-maps";

export interface GeofenceMapPoint {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  summary?: string | null;
  detail?: string | null;
}

export function GeofenceMap({ points, height = 220 }: { points: GeofenceMapPoint[]; colors?: unknown; height?: number }) {
  const office = points[0];
  if (!office) return null;
  return <MapView style={{ height, width: "100%" }} region={{ latitude: office.latitude, longitude: office.longitude, latitudeDelta: 0.016, longitudeDelta: 0.016 }}>
    <Circle center={office} radius={500} fillColor="rgba(37,99,235,0.12)" strokeColor="#2563eb" />
    {points.map(point => <Marker key={point.id} coordinate={point} title={point.label} description={point.summary || undefined} />)}
  </MapView>;
}
