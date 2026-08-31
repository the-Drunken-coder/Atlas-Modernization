export function foregroundEscapeOwner(target: EventTarget | null): Element | null {
  return target instanceof Element
    ? target.closest(
        '[role="listbox"], [role="menu"], [role="dialog"], #account-menu-popover, [aria-controls="account-menu-popover"][aria-expanded="true"], [data-map-source-trigger][aria-expanded="true"], [data-spatial-operation]'
      )
    : null;
}
