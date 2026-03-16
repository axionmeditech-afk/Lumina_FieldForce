import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import type { AppUser, CompanyProfile, UserRole } from "@/lib/types";
import {
  getCurrentUser,
  authenticateUser,
  logoutUser,
  seedDataIfNeeded,
  registerUser,
  getCurrentCompanyProfile,
  syncBackendAuthenticatedUser,
  updateCompanyProfile,
} from "@/lib/storage";
import {
  getAuthenticatedApiUser,
  issueApiToken,
  registerApiUser,
  submitAccessRequestToBackend,
} from "@/lib/attendance-api";

interface SignupInput {
  name: string;
  email: string;
  password: string;
  companyName: string;
  role?: UserRole;
  department?: string;
  branch?: string;
  phone?: string;
  pincode?: string;
  industry?: string;
  headquarters?: string;
}

interface AuthContextValue {
  user: AppUser | null;
  company: CompanyProfile | null;
  isLoading: boolean;
  login: (identifier: string, password: string) => Promise<boolean>;
  signup: (input: SignupInput) => Promise<{ ok: boolean; message?: string; authenticated?: boolean }>;
  updateCompany: (
    updates: Partial<Omit<CompanyProfile, "id" | "createdAt" | "updatedAt">>
  ) => Promise<CompanyProfile | null>;
  refreshSession: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const hydrateApiSession = useCallback(
    async (
      authUser: AppUser,
      email: string,
      password: string,
      allowRegistration: boolean
    ): Promise<void> => {
      try {
        const normalizedEmail = email.trim().toLowerCase();

        const token = await issueApiToken(normalizedEmail, password, { timeoutMs: 1200 });
        if (token || !allowRegistration) {
          return;
        }

        const registerToken = await registerApiUser(
          {
            name: authUser.name,
            email: authUser.email,
            password,
            companyName: authUser.companyName,
            role: authUser.role,
            department: authUser.department,
            branch: authUser.branch,
            phone: authUser.phone,
            pincode: authUser.pincode,
          },
          { timeoutMs: 1600 }
        );
        if (!registerToken) {
          await issueApiToken(normalizedEmail, password, { timeoutMs: 1200 });
        }
      } catch {
        // Keep login/signup fast when backend is slow or unreachable.
      }
    },
    []
  );

  const refreshSession = useCallback(async () => {
    const activeUser = await getCurrentUser();
    setUser(activeUser);
    if (activeUser) {
      const activeCompany = await getCurrentCompanyProfile();
      setCompany(activeCompany);
    } else {
      setCompany(null);
    }
  }, []);

  useEffect(() => {
    const bootstrap = async () => {
      await seedDataIfNeeded();
      await refreshSession();
      setIsLoading(false);
    };
    void bootstrap();
  }, [refreshSession]);

  const login = async (identifier: string, password: string): Promise<boolean> => {
    const rawIdentifier = identifier.trim();
    const normalizedIdentifier = rawIdentifier.includes("@")
      ? rawIdentifier.toLowerCase()
      : rawIdentifier;
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const attemptToken = async (value: string): Promise<string | null> => {
      if (!value) return null;
      let issued = await issueApiToken(value, password, { timeoutMs: 4200 });
      if (!issued) {
        await delay(350);
        issued = await issueApiToken(value, password, { timeoutMs: 4200 });
      }
      return issued;
    };

    let token = await attemptToken(normalizedIdentifier);
    if (!token && rawIdentifier && rawIdentifier !== normalizedIdentifier) {
      token = await attemptToken(rawIdentifier);
    }
    if (!token && rawIdentifier && !rawIdentifier.includes("@")) {
      token = await attemptToken(rawIdentifier.toLowerCase());
    }
    if (token) {
      let remoteUser = await getAuthenticatedApiUser({ timeoutMs: 3200 });
      if (!remoteUser) {
        await delay(250);
        remoteUser = await getAuthenticatedApiUser({ timeoutMs: 3200 });
      }
      if (remoteUser) {
        const hydrated = await syncBackendAuthenticatedUser(remoteUser);
        setUser(hydrated);
        const activeCompany = await getCurrentCompanyProfile();
        setCompany(activeCompany);
        return true;
      }
    }

    const u = await authenticateUser(rawIdentifier, password);
    if (u) {
      setUser(u);
      const activeCompany = await getCurrentCompanyProfile();
      setCompany(activeCompany);
      void hydrateApiSession(u, rawIdentifier, password, true);
      return true;
    }
    return false;
  };

  const signup = async (
    input: SignupInput
  ): Promise<{ ok: boolean; message?: string; authenticated?: boolean }> => {
    const result = await registerUser(input);
    if (!result.ok) {
      return { ok: false, message: result.message || "Registration failed" };
    }
    if (result.user) {
      setUser(result.user);
      setCompany(result.company || (await getCurrentCompanyProfile()));
      void hydrateApiSession(result.user, input.email, input.password, true);
      return { ok: true, message: result.message, authenticated: true };
    }

    await submitAccessRequestToBackend(
      {
        name: input.name,
        email: input.email,
        password: input.password,
        companyName: input.companyName,
        role: input.role,
        department: input.department,
        branch: input.branch,
        phone: input.phone,
        pincode: input.pincode,
      },
      { timeoutMs: 2600 }
    );

    return {
      ok: true,
      message: result.message || "Signup request submitted. Wait for admin approval.",
      authenticated: false,
    };
  };

  const updateCompany = async (
    updates: Partial<Omit<CompanyProfile, "id" | "createdAt" | "updatedAt">>
  ): Promise<CompanyProfile | null> => {
    if (!user?.companyId) return null;
    const updated = await updateCompanyProfile(user.companyId, updates);
    if (updated) {
      setCompany(updated);
      const refreshedUser = await getCurrentUser();
      setUser(refreshedUser);
    }
    return updated;
  };

  const logout = async () => {
    await logoutUser();
    setUser(null);
    setCompany(null);
  };

  const value = { user, company, isLoading, login, signup, updateCompany, refreshSession, logout };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
