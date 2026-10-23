import { StrictMode, useActionState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

async function logIn(_previousError: string, form: FormData): Promise<string> {
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: form.get('password') }),
    });
    if (response.ok) {
      location.replace('/');
      return '';
    }
    return response.status === 401 ? 'Wrong password.' : `Login failed (${response.status}).`;
  } catch {
    return 'The server cannot be reached.';
  }
}

function Login() {
  const [error, submit, pending] = useActionState(logIn, '');
  const password = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error) password.current?.focus();
  }, [error]);
  return (
    <main className="login">
      <img src="/icon.svg" alt="" width="72" height="72" />
      <h1>Media Renamer</h1>
      <form className="panel" action={submit}>
        <label>
          Password
          <input ref={password} name="password" type="password" autoComplete="current-password" required autoFocus />
        </label>
        <p className="login-error" role="alert">
          {error}
        </p>
        <button type="submit" className="primary" disabled={pending}>
          Log in
        </button>
      </form>
    </main>
  );
}

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <Login />
  </StrictMode>,
);
