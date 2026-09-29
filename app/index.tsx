import { Redirect } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { StartScreen } from "@/components/StartScreen";
export default function IndexScreen() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <StartScreen />;
  return <Redirect href={user ? "/(tabs)" : "/login"} />;
}
