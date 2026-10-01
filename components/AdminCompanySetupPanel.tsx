import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ExpoLocation from "expo-location";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import {
  createCompanyProfileRemote,
  createGeofence,
  getCompanyProfilesRemote,
  searchMapplsAutosuggest,
  searchMapplsTextSearch,
  updateGeofence,
} from "@/lib/attendance-api";
import { ensureLocationServicesEnabled, requestLocationPermissionBundle } from "@/lib/location-service";
import type { CompanyProfile, Geofence } from "@/lib/types";

const OFFICE_RADIUS_METERS = 500;
const SEARCH_LIMIT = 10;
const MIN_SEARCH_CHARS = 2;

type OfficeLocation = {
  id: string;
  label: string;
  address: string | null;
  latitude: number;
  longitude: number;
};

function isValidCoordinate(latitude: unknown, longitude: unknown): boolean {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

function makeLocationId(prefix: string, index: number): string {
  return `${prefix}_${Date.now()}_${index}`;
}

function mergeLocations(current: OfficeLocation[], next: OfficeLocation[]): OfficeLocation[] {
  const byKey = new Map<string, OfficeLocation>();
  for (const item of [...current, ...next]) {
    byKey.set(`${item.latitude.toFixed(6)}:${item.longitude.toFixed(6)}:${item.label.toLowerCase()}`, item);
  }
  return Array.from(byKey.values()).slice(0, SEARCH_LIMIT);
}

export function AdminCompanySetupPanel() {
  const { user, refreshSession } = useAuth();
  const { colors } = useAppTheme();
  const [companies, setCompanies] = useState<CompanyProfile[]>([]);
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [headquarters, setHeadquarters] = useState("");
  const [officeName, setOfficeName] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OfficeLocation[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<OfficeLocation | null>(null);
  const [loadingCompanies, setLoadingCompanies] = useState(false);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const isAdmin = user?.role === "admin";

  const loadCompanies = useCallback(async () => {
    if (!isAdmin) return;
    setLoadingCompanies(true);
    try {
      setCompanies(await getCompanyProfilesRemote());
    } catch (error) {
      Alert.alert("Companies", error instanceof Error ? error.message : "Unable to load companies.");
    } finally {
      setLoadingCompanies(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadCompanies();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadCompanies]);

  const canSave = useMemo(
    () => Boolean(name.trim() && selectedLocation && !saving),
    [name, saving, selectedLocation],
  );

  const selectLocation = useCallback((location: OfficeLocation) => {
    setSelectedLocation(location);
    setQuery(location.label);
    setOfficeName((current) => current.trim() || location.label);
    setResults([]);
  }, []);

  const searchLocations = useCallback(async () => {
    const text = query.trim();
    if (text.length < MIN_SEARCH_CHARS) {
      Alert.alert("Search required", "Enter at least 2 characters of office name, area, or address.");
      return;
    }
    setSearching(true);
    try {
      let merged: OfficeLocation[] = [];

      const [autosuggest, textSearch] = await Promise.all([
        searchMapplsAutosuggest(text, { region: "ind", limit: SEARCH_LIMIT }).catch(() => null),
        searchMapplsTextSearch(text, { region: "ind", limit: SEARCH_LIMIT }).catch(() => null),
      ]);

      for (const payload of [autosuggest, textSearch]) {
        const mapped = (payload?.suggestions || [])
          .map((suggestion, index): OfficeLocation | null => {
            if (!isValidCoordinate(suggestion.latitude, suggestion.longitude)) return null;
            return {
              id: suggestion.id || makeLocationId("mappls", index),
              label: suggestion.label,
              address: suggestion.address,
              latitude: suggestion.latitude as number,
              longitude: suggestion.longitude as number,
            };
          })
          .filter((item): item is OfficeLocation => Boolean(item));
        merged = mergeLocations(merged, mapped);
      }

      if (text.length >= 4 && merged.length < SEARCH_LIMIT) {
        try {
          const params = new URLSearchParams({
            q: text,
            format: "jsonv2",
            addressdetails: "1",
            limit: String(SEARCH_LIMIT),
            countrycodes: "in",
          });
          const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
            method: "GET",
            headers: {
              Accept: "application/json",
              "Accept-Language": "en-IN,en",
              "User-Agent": "LuminaFieldForce/1.0 (company-office-geofence)",
            },
          });
          if (response.ok) {
            const payload = (await response.json()) as {
              lat?: string;
              lon?: string;
              name?: string;
              display_name?: string;
            }[];
            const osmResults = payload
              .map((item, index): OfficeLocation | null => {
                const latitude = Number.parseFloat(item.lat || "");
                const longitude = Number.parseFloat(item.lon || "");
                if (!isValidCoordinate(latitude, longitude)) return null;
                const displayName = (item.display_name || "").trim();
                return {
                  id: makeLocationId("osm", index),
                  label: (item.name || "").trim() || displayName.split(",")[0]?.trim() || text,
                  address: displayName || null,
                  latitude,
                  longitude,
                };
              })
              .filter((item): item is OfficeLocation => Boolean(item));
            merged = mergeLocations(merged, osmResults);
          }
        } catch {
          // Mappls or current GPS can still provide a location.
        }
      }

      setResults(merged);
      if (!merged.length) {
        Alert.alert("No results", "Try a more specific office, landmark, or full address.");
      }
    } catch (error) {
      Alert.alert("Search failed", error instanceof Error ? error.message : "Unable to search office location.");
    } finally {
      setSearching(false);
    }
  }, [query]);

  const applyCurrentLocation = useCallback(async () => {
    setLocating(true);
    try {
      const permission = await requestLocationPermissionBundle();
      if (!permission.foreground) {
        Alert.alert("Location required", "Allow location permission to set office from current GPS.");
        return;
      }
      if (!(await ensureLocationServicesEnabled())) {
        Alert.alert("Turn on GPS", "Please enable device location services and try again.");
        return;
      }
      const position = await ExpoLocation.getCurrentPositionAsync({
        accuracy: ExpoLocation.Accuracy.High,
        mayShowUserSettingsDialog: true,
      });
      const accuracy =
        typeof position.coords.accuracy === "number" && Number.isFinite(position.coords.accuracy)
          ? Math.round(position.coords.accuracy)
          : null;
      selectLocation({
        id: "current_gps",
        label: officeName.trim() || name.trim() || "Current Location Office",
        address: accuracy === null ? "Device GPS location" : `Device GPS location, accuracy +/-${accuracy}m`,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      });
    } catch (error) {
      Alert.alert("Current location failed", error instanceof Error ? error.message : "Unable to fetch current location.");
    } finally {
      setLocating(false);
    }
  }, [name, officeName, selectLocation]);

  const saveCompany = useCallback(async () => {
    if (!canSave || !selectedLocation || !user) return;
    const cleanName = name.trim();
    const cleanOfficeName = officeName.trim() || selectedLocation.label || `${cleanName} Main Office`;
    setSaving(true);
    try {
      const company = await createCompanyProfileRemote({
        name: cleanName,
        legalName: cleanName,
        industry: "Field Operations",
        headquarters: headquarters.trim() || "India",
        primaryBranch: branch.trim() || "Main Branch",
        attendanceZoneLabel: cleanOfficeName,
      });
      const now = new Date().toISOString();
      const geofence: Geofence = {
        id: `office_${company.id}`,
        companyId: company.id,
        name: cleanOfficeName,
        radiusMeters: OFFICE_RADIUS_METERS,
        latitude: selectedLocation.latitude,
        longitude: selectedLocation.longitude,
        assignedEmployeeIds: [],
        isActive: true,
        allowOverride: false,
        workingHoursStart: null,
        workingHoursEnd: null,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await createGeofence(geofence);
      } catch {
        await updateGeofence(geofence.id, geofence);
      }
      setName("");
      setBranch("");
      setHeadquarters("");
      setOfficeName("");
      setQuery("");
      setResults([]);
      setSelectedLocation(null);
      await Promise.all([loadCompanies(), refreshSession()]);
      Alert.alert("Company ready", `${company.name} was created with a ${OFFICE_RADIUS_METERS}m office geofence.`);
    } catch (error) {
      Alert.alert("Create failed", error instanceof Error ? error.message : "Unable to create company and office geofence.");
    } finally {
      setSaving(false);
    }
  }, [
    branch,
    canSave,
    headquarters,
    loadCompanies,
    name,
    officeName,
    refreshSession,
    selectedLocation,
    user,
  ]);

  if (!isAdmin) return null;

  return (
    <View style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
      <View style={styles.headerRow}>
        <View style={styles.headerIcon}>
          <Ionicons name="business-outline" size={20} color={colors.primary} />
        </View>
        <View style={styles.headerCopy}>
          <Text style={[styles.title, { color: colors.text }]}>Company & Office Geofence</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            Create a workspace and lock attendance to its office location.
          </Text>
        </View>
      </View>

      <View style={styles.formGrid}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Company / workspace name"
          placeholderTextColor={colors.textTertiary}
          style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
        />
        <TextInput
          value={branch}
          onChangeText={setBranch}
          placeholder="Primary branch"
          placeholderTextColor={colors.textTertiary}
          style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
        />
        <TextInput
          value={headquarters}
          onChangeText={setHeadquarters}
          placeholder="Headquarters"
          placeholderTextColor={colors.textTertiary}
          style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
        />
        <TextInput
          value={officeName}
          onChangeText={setOfficeName}
          placeholder="Office geofence name"
          placeholderTextColor={colors.textTertiary}
          style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
        />
      </View>

      <View style={styles.searchRow}>
        <TextInput
          value={query}
          onChangeText={(value) => {
            setQuery(value);
            setSelectedLocation(null);
          }}
          placeholder="Search office, area, landmark, address"
          placeholderTextColor={colors.textTertiary}
          style={[styles.searchInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
        />
        <Pressable
          disabled={searching}
          onPress={() => void searchLocations()}
          style={({ pressed }) => [
            styles.iconButton,
            { backgroundColor: colors.primary, opacity: pressed || searching ? 0.75 : 1 },
          ]}
        >
          {searching ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="search" size={19} color="#FFFFFF" />}
        </Pressable>
      </View>

      <Pressable
        disabled={locating}
        onPress={() => void applyCurrentLocation()}
        style={({ pressed }) => [
          styles.secondaryButton,
          { borderColor: colors.border, backgroundColor: colors.surface, opacity: pressed || locating ? 0.78 : 1 },
        ]}
      >
        <Ionicons name="navigate-outline" size={18} color={colors.primary} />
        <Text style={[styles.secondaryButtonText, { color: colors.text }]}>
          {locating ? "Reading current GPS..." : "Use current GPS as office"}
        </Text>
      </Pressable>

      {results.length ? (
        <View style={styles.results}>
          {results.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => selectLocation(item)}
              style={({ pressed }) => [
                styles.resultCard,
                {
                  borderColor: colors.borderLight,
                  backgroundColor: selectedLocation?.id === item.id ? `${colors.primary}12` : colors.surface,
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              <Ionicons name="location-outline" size={18} color={colors.primary} />
              <View style={styles.resultCopy}>
                <Text style={[styles.resultTitle, { color: colors.text }]}>{item.label}</Text>
                <Text style={[styles.resultMeta, { color: colors.textSecondary }]} numberOfLines={2}>
                  {item.address || `${item.latitude.toFixed(6)}, ${item.longitude.toFixed(6)}`}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}

      {selectedLocation ? (
        <View style={[styles.selectedBox, { borderColor: `${colors.success}55`, backgroundColor: `${colors.success}12` }]}>
          <Ionicons name="checkmark-circle-outline" size={20} color={colors.success} />
          <Text style={[styles.selectedText, { color: colors.text }]}>
            {selectedLocation.label} - {selectedLocation.latitude.toFixed(6)}, {selectedLocation.longitude.toFixed(6)} / {OFFICE_RADIUS_METERS}m
          </Text>
        </View>
      ) : null}

      <Pressable
        disabled={!canSave}
        onPress={() => void saveCompany()}
        style={({ pressed }) => [
          styles.primaryButton,
          { backgroundColor: colors.primary, opacity: !canSave ? 0.45 : pressed ? 0.82 : 1 },
        ]}
      >
        <Text style={styles.primaryButtonText}>{saving ? "Creating..." : "Create company with office geofence"}</Text>
      </Pressable>

      <View style={styles.companyListHeader}>
        <Text style={[styles.listTitle, { color: colors.text }]}>Existing Workspaces</Text>
        <Pressable disabled={loadingCompanies} onPress={() => void loadCompanies()}>
          <Text style={[styles.linkText, { color: colors.primary }]}>{loadingCompanies ? "Loading" : "Refresh"}</Text>
        </Pressable>
      </View>
      {companies.map((company) => (
        <View key={company.id} style={[styles.companyRow, { borderColor: colors.borderLight }]}>
          <View>
            <Text style={[styles.companyName, { color: colors.text }]}>{company.name}</Text>
            <Text style={[styles.companyMeta, { color: colors.textSecondary }]}>
              {company.primaryBranch || "Main Branch"} - {company.attendanceZoneLabel || "Office geofence not named"}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 18,
    gap: 14,
  },
  headerRow: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  headerIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(14,95,216,0.12)",
  },
  headerCopy: {
    flex: 1,
    gap: 3,
  },
  title: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
  },
  subtitle: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 18,
  },
  formGrid: {
    gap: 10,
  },
  input: {
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 14,
    fontFamily: "Inter_500Medium",
  },
  searchRow: {
    flexDirection: "row",
    gap: 10,
  },
  searchInput: {
    flex: 1,
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 14,
    fontFamily: "Inter_500Medium",
  },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButton: {
    minHeight: 46,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  secondaryButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  results: {
    gap: 8,
  },
  resultCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    flexDirection: "row",
    gap: 10,
  },
  resultCopy: {
    flex: 1,
    gap: 3,
  },
  resultTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 13.5,
  },
  resultMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 17,
  },
  selectedBox: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 12,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  selectedText: {
    flex: 1,
    fontFamily: "Inter_500Medium",
    fontSize: 12.5,
    lineHeight: 18,
  },
  primaryButton: {
    minHeight: 50,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontFamily: "Inter_700Bold",
    fontSize: 14,
  },
  companyListHeader: {
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  listTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 15,
  },
  linkText: {
    fontFamily: "Inter_700Bold",
    fontSize: 13,
  },
  companyRow: {
    borderTopWidth: 1,
    paddingTop: 10,
  },
  companyName: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
  },
  companyMeta: {
    marginTop: 2,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
});
