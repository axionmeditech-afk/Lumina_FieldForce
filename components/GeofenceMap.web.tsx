
import { Linking, Pressable, Text, View } from "react-native";
import type { GeofenceMapPoint } from "./GeofenceMap";
export type { GeofenceMapPoint } from "./GeofenceMap";

export function GeofenceMap({ points, height = 220 }: { points: GeofenceMapPoint[]; colors?: unknown; height?: number }) {
  const office = points[0];
  if (!office) return null;
  return <View style={{ minHeight: height, padding: 20, backgroundColor: "#eff6ff", justifyContent: "center", gap: 12 }}>
    <Text style={{ color: "#1e3a8a", fontSize: 18 }}>{office.label}</Text>
    <Text>{office.latitude.toFixed(5)}, {office.longitude.toFixed(5)} · 500 m geofence</Text>
    <Pressable onPress={() => void Linking.openURL(`https://www.google.com/maps?q=${office.latitude},${office.longitude}`)}>
      <Text style={{ color: "#2563eb" }}>Open office location in Maps</Text>
    </Pressable>
  </View>;
}
