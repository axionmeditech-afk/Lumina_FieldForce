import { useEffect, useMemo, useState } from "react";
import { Redirect } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { StartScreen } from "@/components/StartScreen";

export default function IndexScreen() {
  const { user, isLoading } = useAuth();
  const [videoComplete, setVideoComplete] = useState(false);

  useEffect(() => {
    const fallback = setTimeout(() => setVideoComplete(true), 8000);
    return () => clearTimeout(fallback);
  }, []);

  const subtitle = useMemo(() => {
    if (isLoading) return "Preparing your workspace";
    return "Final checks before launch";
  }, [isLoading]);

  const hint = useMemo(() => {
    if (isLoading) return "Securing data and syncing live tools";
    return "Optimizing your session";
  }, [isLoading]);

  if (!videoComplete) {
    return <StartScreen showVideo onVideoFinish={() => setVideoComplete(true)} />;
  }

  if (isLoading) {
    return <StartScreen subtitle={subtitle} hint={hint} />;
  }

  if (user) {
    return <Redirect href="/(tabs)" />;
  }

  return <Redirect href="/login" />;
}
