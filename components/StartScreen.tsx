import { LinearGradient } from "expo-linear-gradient";
import React, { useEffect, useRef, useState } from "react";
import { ResizeMode, Video, type AVPlaybackStatus } from "expo-av";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";

const BRAND_NAME = "Lumina FieldForce";

interface StartScreenProps {
  title?: string;
  subtitle?: string;
  hint?: string;
  showVideo?: boolean;
  onVideoFinish?: () => void;
}

export function StartScreen({
  title = BRAND_NAME,
  subtitle = "Preparing your workspace",
  hint = "Securing data and syncing live tools",
  showVideo = false,
  onVideoFinish,
}: StartScreenProps) {
  const { colors, isDark } = useAppTheme();
  const pulse = useRef(new Animated.Value(0)).current;
  const orbit = useRef(new Animated.Value(0)).current;
  const [videoFailed, setVideoFailed] = useState(false);
  const [videoReady, setVideoReady] = useState(false);

  useEffect(() => {
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    const orbitLoop = Animated.loop(
      Animated.timing(orbit, {
        toValue: 1,
        duration: 8600,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    pulseLoop.start();
    orbitLoop.start();

    return () => {
      pulseLoop.stop();
      orbitLoop.stop();
    };
  }, [orbit, pulse]);

  const pulseScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.08],
  });
  const pulseOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.55],
  });
  const orbitRotate = orbit.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  if (showVideo) {
    return (
      <View style={[styles.videoRoot, { backgroundColor: "#05070D" }]}>
        <Image
          source={require("../assets/images/logo.png")}
          style={[styles.videoFallback, videoReady && !videoFailed ? styles.videoFallbackHidden : null]}
          resizeMode="contain"
        />
        <Video
          source={require("../assets/images/splash-video.mp4")}
          style={[StyleSheet.absoluteFill, videoFailed ? styles.videoHidden : null]}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay
          isMuted
          volume={0}
          isLooping={false}
          onReadyForDisplay={() => setVideoReady(true)}
          onLoad={() => setVideoReady(true)}
          onPlaybackStatusUpdate={(status: AVPlaybackStatus) => {
            if (!status.isLoaded) return;
            if (status.didJustFinish) {
              onVideoFinish?.();
            }
          }}
          onError={() => setVideoFailed(true)}
        />
      </View>
    );
  }

  return (
    <AppCanvas>
      <View style={styles.container}>
        <View style={styles.brandWrap}>
          <View style={[styles.logoGlow, { backgroundColor: `${colors.primary}22` }]} />
          <View style={[styles.logoGlow, styles.logoGlowSoft, { backgroundColor: `${colors.secondary}18` }]} />
          <Animated.View
            style={[
              styles.pulseRing,
              {
                borderColor: `${colors.primary}55`,
                opacity: pulseOpacity,
                transform: [{ scale: pulseScale }],
              },
            ]}
          />
          <Animated.View
            style={[
              styles.orbitRing,
              {
                borderColor: `${colors.primary}30`,
                transform: [{ rotate: orbitRotate }],
              },
            ]}
          >
            <View style={[styles.orbitDot, { backgroundColor: colors.primary }]} />
          </Animated.View>
          <LinearGradient
            colors={[colors.heroStart, colors.heroEnd]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[
              styles.logoCard,
              {
                shadowColor: colors.cardShadow,
              },
            ]}
          >
            <Image
              source={require("../assets/images/logo.png")}
              style={styles.logoImage}
              resizeMode="cover"
            />
          </LinearGradient>
        </View>

        <Text style={[styles.title, { color: colors.text, fontFamily: "Inter_700Bold" }]}>{title}</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
          {subtitle}
        </Text>
        <View
          style={[
            styles.badge,
            {
              backgroundColor: isDark ? colors.surfaceSecondary : colors.backgroundElevated,
              borderColor: colors.border,
            },
          ]}
        >
          <View style={[styles.badgeDot, { backgroundColor: colors.success }]} />
          <Text style={[styles.badgeText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
            Enterprise-grade security and sync
          </Text>
        </View>

        <View
          style={[
            styles.statusPill,
            {
              backgroundColor: isDark ? colors.surfaceSecondary : colors.backgroundElevated,
              borderColor: colors.border,
            },
          ]}
        >
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.statusText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
            {hint}
          </Text>
        </View>
      </View>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  videoRoot: {
    flex: 1,
  },
  videoFallback: {
    width: "100%",
    height: "100%",
  },
  videoFallbackHidden: {
    opacity: 0,
  },
  videoHidden: {
    opacity: 0,
  },
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 28,
  },
  brandWrap: {
    alignItems: "center",
    justifyContent: "center",
    height: 280,
    width: 280,
    marginBottom: 16,
  },
  logoGlow: {
    position: "absolute",
    width: 210,
    height: 210,
    borderRadius: 105,
  },
  logoGlowSoft: {
    width: 240,
    height: 240,
    borderRadius: 120,
    opacity: 0.7,
  },
  logoCard: {
    width: 172,
    height: 172,
    borderRadius: 52,
    alignItems: "center",
    justifyContent: "center",
    elevation: 8,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.28,
    shadowRadius: 24,
    overflow: "hidden",
  },
  logoImage: {
    width: 172,
    height: 172,
  },
  pulseRing: {
    position: "absolute",
    width: 232,
    height: 232,
    borderRadius: 116,
    borderWidth: 2,
  },
  orbitRing: {
    position: "absolute",
    width: 262,
    height: 262,
    borderRadius: 131,
    borderWidth: 1.5,
  },
  orbitDot: {
    position: "absolute",
    top: -5,
    left: "50%",
    width: 10,
    height: 10,
    borderRadius: 5,
    marginLeft: -5,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
  },
  title: {
    fontSize: 26,
    letterSpacing: 0.6,
  },
  subtitle: {
    marginTop: 6,
    fontSize: 15,
    textAlign: "center",
  },
  badge: {
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  badgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 12.5,
    letterSpacing: 0.2,
  },
  statusPill: {
    marginTop: 18,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  statusText: {
    fontSize: 13,
  },
});
