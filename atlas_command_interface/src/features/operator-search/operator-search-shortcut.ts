export function isOperatorSearchShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">,
  platform: string
): boolean {
  if (event.altKey || event.key.toLocaleLowerCase() !== "k") return false;
  return /Mac|iPhone|iPad|iPod/.test(platform) ? event.metaKey : event.ctrlKey;
}

export function operatorSearchShortcutLabel(platform: string): string {
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "⌘K" : "Ctrl K";
}
