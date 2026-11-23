import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { LEGACY_FIELD_TRACKING_LOCATION_TASKS } from "./field-tracking/task-names";

// Stop the previous version's registered task when upgrading an existing install.
export async function retireLegacyLocationTracking() {
  if (Platform.OS !== "web") {
    for (const task of LEGACY_FIELD_TRACKING_LOCATION_TASKS) {
      if (await Location.hasStartedLocationUpdatesAsync(task).catch(() => false)) {
        await Location.stopLocationUpdatesAsync(task).catch(() => undefined);
      }
    }
  }
  await AsyncStorage.removeItem("@trackforce_background_location_queue");
}
