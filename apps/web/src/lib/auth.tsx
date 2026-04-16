'use client';

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { apiGet, setTokens, clearTokens } from './api';

interface Broker {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  role: string;
  status: string;
  funnelStage: string;
  agencies: {
    id: string;
    name: string;
    inn: string;
    isPrimary: boolean;
    commissionLevel: string;
  }[];
  createdAt: string;
}

interface AuthContextType {
  broker: Broker | null;
  loading: boolean;
  login: (accessToken: string, refreshToken: string) => void;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  broker: null,
  loading: true,
  login: () => {},
  logout: () => {},
  refresh: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [broker, setBroker] = useState<Broker | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const fetchProfile = useCallback(async () => {
    try {
      const token = localStorage.getItem('accessToken');
      if (!token) {
        setBroker(null);
        setLoading(false);
        return;
      }
      const data = await apiGet<Broker>('/auth/me');
      setBroker(data);
    } catch {
      setBroker(null);
      clearTokens();
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  // Redirect logic
  useEffect(() => {
    if (loading) return;

    const isAuthPage = pathname === '/login' || pathname === '/register';
    const isLanding = pathname === '/';
    const isPublic = pathname === '/reset-password';

    if (!broker && !isAuthPage && !isLanding && !isPublic) {
      router.replace('/');
    } else if (broker && isAuthPage) {
      // Logged-in users land on landing page, not cabinet — entering cabinet is explicit via button
      router.replace('/');
    }
  }, [broker, loading, pathname, router]);

  const login = useCallback((accessToken: string, refreshToken: string) => {
    setTokens(accessToken, refreshToken);
    fetchProfile();
  }, [fetchProfile]);

  const logout = useCallback(() => {
    clearTokens();
    setBroker(null);
    router.replace('/login');
  }, [router]);

  return (
    <AuthContext.Provider value={{ broker, loading, login, logout, refresh: fetchProfile }}>
      {children}
    </AuthContext.Provider>
  );
}
