export const TIMELINE_PAGE_SIZE = 40;

// A null page follows the newest segment. An explicit page is a reader's choice
// and stays fixed when live events grow; planning never removes source entries.
export function planTimelineWindow(total, page = null, pageSize = TIMELINE_PAGE_SIZE) {
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const size = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : TIMELINE_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(count / size));
  const lastPage = pages - 1;
  const selected = page == null || !Number.isFinite(page) ? lastPage : Math.max(0, Math.min(lastPage, Math.floor(page)));
  const start = selected * size;
  const end = Math.min(count, start + size);
  return { total: count, page: selected, pages, lastPage, start, end, hasEarlier: selected > 0, hasLater: selected < lastPage };
}
