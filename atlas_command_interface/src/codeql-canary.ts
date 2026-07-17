// Intentionally vulnerable CodeQL canary. DO NOT MERGE.
export function codeQLXssCanary(): void {
  document.body.innerHTML = document.location.href;
}
