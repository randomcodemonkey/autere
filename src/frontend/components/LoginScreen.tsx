import React, { useState } from 'react';
import { url } from '../base-path';

interface LoginScreenProps {
  open: boolean;
  error: string;
  onLogin: (user: string, password: string) => Promise<boolean>;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ open, error, onLogin }) => {
  const [user, setUser] = useState('admin');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const success = await onLogin(user, password);
    if (success) {
      setPassword('');
    }
  };

  return (
    <div className={`login-screen${open ? ' open' : ''}`}>
      <div className="login-form-container">
        <h2 className="login-title"><img className="logo-icon" src={url('/logo.svg')} alt="autere" /> autere</h2>
        <form id="login-form" onSubmit={handleSubmit}>
          <input
            className="login-input"
            type="text"
            placeholder="Username"
            autoComplete="username"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoFocus
          />
          <input
            className="login-input"
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className={`login-error${error ? ' visible' : ''}`}>
            {error}
          </div>
          <button type="submit" className="login-btn">Login</button>
        </form>
      </div>
    </div>
  );
};
