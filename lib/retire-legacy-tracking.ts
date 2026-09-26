import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

// Stop the previous version's registered task when upgrading an existing install.
export async function retireLegacyLocationTracking() {
  if (Platform.OS !== "web") {
    const task = "trackforce-background-location-task-v1";
    if (await Location.hasStartedLocationUpdatesAsync(task)) {
      await Location.stopLocationUpdatesAsync(task);
    }
  }
  await AsyncStorage.removeItem("@trackforce_background_location_queue");
}
