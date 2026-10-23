import { useState, useCallback } from 'react';
import { applyTheme } from '../theme';
import { API } from '../api-paths';
import { apiJSON, apiBody, apiSend, JSON_HEADERS } from '../api';

export function useAuth() {
  const [authenticated, setAuthenticated] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [userRole, setUserRole] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);

  const checkAuthStatus = useCallback(async (): Promise<boolean> => {
    try {
      const data = await apiJSON<any>(API.auth.status);
      if (data.authEnabled && !data.authenticated) {
        setAuthEnabled(true);
        setAuthenticated(false);
        setUserRole(null);
        setUsername(null);
        setMustChangePassword(false);
        return false;
      }
      setAuthEnabled(data.authEnabled);
      setAuthenticated(true);
      setUserRole(data.role || null);
      setUsername(data.user || null);
      setMustChangePassword(!!data.mustChangePassword);
      applyTheme(data.data.theme); // per-user theme, persisted server-side
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
      const data = await apiBody(API.auth.login, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ user, password }) });
      setAuthenticated(true);
      // Set the forced-change flag from the login response itself, in the
      // same batch as `authenticated`. Otherwise App renders <Routes> for
      // one tick with mustChangePassword still false, RootRedirect fires
      // GET /sessions (403 under the change gate) and lands on the
      // fallback /session/- — which then persists past the password change.
      setMustChangePassword(!!data.mustChangePassword);
      setLoginError('');
      // The login response doesn't carry user info (username/role) —
      // fetch it now, otherwise the status modal shows '—' after a
      // logout-login cycle.
      await checkAuthStatus();
      return true;
    } catch (err: any) {
      setLoginError(err.message || 'Connection error');
      return false;
    }
  }, [checkAuthStatus]);

  const logout = useCallback(async () => {
    try {
      await apiSend(API.auth.logout, 'POST');
    } catch {}
    setAuthenticated(false);
  }, []);

  return { authenticated, authEnabled, loginError, userRole, username, mustChangePassword, checkAuthStatus, login, logout };
}
