const form = document.getElementById('login');
const error = document.getElementById('error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value }),
    });
    if (response.ok) return location.replace('/');
    error.textContent = response.status === 401 ? 'Wrong password.' : `Login failed (${response.status}).`;
  } catch {
    error.textContent = 'The server cannot be reached.';
  }
  button.disabled = false;
  document.getElementById('password').select();
});
