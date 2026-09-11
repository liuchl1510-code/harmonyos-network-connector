// Window widths are logical vp, not the display's physical pixel resolution.
// A resized PC window and a similarly sized tablet use the same layout rules.
export function normalizedWindowWidth(width: number): number {
  return Number.isFinite(width) && width > 0 ? Math.min(width, 16384) : 360;
}

export function useSideNavigation(width: number): boolean {
  return normalizedWindowWidth(width) >= 1024;
}

export function contentViewportWidth(width: number): number {
  const value = normalizedWindowWidth(width);
  return value - (useSideNavigation(value) ? 176 : 0);
}

export function formContentWidth(width: number): number {
  return Math.min(normalizedWindowWidth(width), 840);
}

export function primaryContentWidth(width: number): number {
  return Math.min(contentViewportWidth(width), 1200);
}

export function homeUsesColumns(width: number): boolean {
  return primaryContentWidth(width) >= 680;
}

export function nodeListContentWidth(width: number): number {
  return Math.min(contentViewportWidth(width), 1200);
}

export function nodeListUsesDetails(width: number): boolean {
  return nodeListContentWidth(width) >= 1020;
}

export function nodeListPaneWidth(width: number): number {
  return Math.max(1, nodeListContentWidth(width) - 40 - (nodeListUsesDetails(width) ? 316 : 0));
}
