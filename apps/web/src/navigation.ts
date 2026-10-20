export interface NavLink {
  href: string;
  label: string;
  badge?: string;
}

export interface NavGroup {
  heading?: string;
  links: NavLink[];
}

// The side index for every page. Docs pages read their previous and next links from it.
export const navGroups: NavGroup[] = [
  {
    links: [
      { href: "/", label: "Overview" },
      { href: "/docs/", label: "Introduction" },
      { href: "/docs/install/", label: "Install" },
      { href: "/docs/mcp/", label: "Connect OpenCode", badge: "new" },
      { href: "/docs/ci/", label: "CI usage" },
    ],
  },
  {
    heading: "How it works",
    links: [
      { href: "/docs/review/", label: "How a review runs" },
      { href: "/docs/reading-comments/", label: "Reading a comment" },
      { href: "/docs/untrusted-input/", label: "Untrusted input" },
      { href: "/docs/principles/", label: "Principles" },
    ],
  },
  {
    heading: "Reference",
    links: [{ href: "/docs/configuration/", label: "Configuration" }],
  },
  {
    heading: "Resources",
    links: [
      { href: "/examples/", label: "Examples" },
      { href: "/design/", label: "Design" },
      { href: "/notes/", label: "Notes" },
      { href: "https://github.com/99Yash/warden/blob/main/decisions.md", label: "Decisions" },
    ],
  },
];

/** The site's own pages in index order, for previous and next links. */
export const pageOrder: NavLink[] = navGroups
  .flatMap((group) => group.links)
  .filter((link) => link.href.startsWith("/"));
