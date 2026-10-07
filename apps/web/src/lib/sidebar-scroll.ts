export const SIDEBAR_BODY_OPEN_CLASS = 'cabinet-sidebar-open';

/** Own only a body class: never overwrite a material viewer's inline scroll lock. */
export function lockSidebarBodyScroll(
  classList: Pick<DOMTokenList, 'contains' | 'add' | 'remove'>,
): () => void {
  const wasAlreadyOpen = classList.contains(SIDEBAR_BODY_OPEN_CLASS);
  classList.add(SIDEBAR_BODY_OPEN_CLASS);

  return () => {
    if (!wasAlreadyOpen) classList.remove(SIDEBAR_BODY_OPEN_CLASS);
  };
}
