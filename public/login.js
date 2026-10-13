const password = document.getElementById('password');
const toggle = document.getElementById('toggle-password');
toggle.addEventListener('click', () => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  toggle.textContent = visible ? 'Hide password' : 'Show password';
  toggle.setAttribute('aria-pressed', String(visible));
});
