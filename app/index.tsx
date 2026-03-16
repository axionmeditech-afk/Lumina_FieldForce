import { useEffect, useState } from "react";
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

  if (!videoComplete || isLoading) {
    return <StartScreen showVideo onVideoFinish={() => setVideoComplete(true)} />;
  }

  if (user) {
    return <Redirect href="/(tabs)" />;
  }

  return <Redirect href="/login" />;
}
