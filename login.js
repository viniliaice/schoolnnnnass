const emailInput = document.querySelector('input[type="email"], input[placeholder*="Email"]');
const passwordInput = document.querySelector('input[type="password"]');
const signInBtn = document.querySelector('button:not([class*="hidden"])');
if (emailInput && passwordInput) {
  emailInput.value = 'fardosa@gmail.com';
  passwordInput.value = 'fardosa@gmail.com';
  if (signInBtn) signInBtn.click();
}
