import { soon } from './soon';

// The docs menu, in order. Each file holds the pages of one group.
export const DOC_GROUPS = [
  { title: 'Place', pages: soon },
];

export const DOC_PAGES = DOC_GROUPS.flatMap((group) => group.pages);
