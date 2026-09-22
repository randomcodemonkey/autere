import { useState, useCallback } from 'react';
import { url } from '../base-path';

export function useAuth() {
  const [authenticated, setAuthenticated] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [userRole, setUserRole] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);

  const checkAuthStatus = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(url('/api/auth/status'));
      const data = await res.json();
      if (data.success && data.data.authEnabled && !data.data.authenticated) {
        setAuthEnabled(true);
        setAuthenticated(false);
        setUserRole(null);
        setUsername(null);
        setMustChangePassword(false);
        return false;
      }
      setAuthEnabled(data.data.authEnabled);
      setAuthenticated(true);
      setUserRole(data.data.role || null);
      setUsername(data.data.user || null);
      setMustChangePassword(!!data.data.mustChangePassword);
      return true;
    } catch {
      return false;
    }
  }, []);

  const login = useCallback(async (user: string, password: string): Promise<boolean> => {
    setLoginError('');
    if (!user) {
      setLoginError('Enter username');
      return false;
    }
    if (!password) {
      setLoginError('Enter password');
      return false;
    }
    try {
      const res = await fetch(url('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, password }),
      });
      const data = await res.json();
      if (data.success) {
        setAuthenticated(true);
        setLoginError('');
        // The login response doesn't carry user info (username/role) —
        // fetch it now, otherwise the status modal shows '—' after a
        // logout-login cycle.
        await checkAuthStatus();
        return true;
      } else {
        setLoginError(data.error || 'Login failed');
        return false;
      }
    } catch {
      setLoginError('Connection error');
      return false;
    }
  }, [checkAuthStatus]);

  const logout = useCallback(async () => {
    try {
      await fetch(url('/api/auth/logout'), { method: 'POST' });
    } catch {}
    setAuthenticated(false);
  }, []);

  return { authenticated, authEnabled, loginError, userRole, username, mustChangePassword, checkAuthStatus, login, logout };
}
