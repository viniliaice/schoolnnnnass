// Find the Light/Dark mode toggle button
document.querySelectorAll('button').forEach(b => {
  const label = b.getAttribute('aria-label') || '';
  if (label.includes('Toggle') || label.includes('light') || label.includes('dark')) {
    b.click();
  }
});
