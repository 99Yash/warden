import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://wrdn.beauty",
  markdown: {
    smartypants: false,
  },
  devToolbar: {
    enabled: false,
  },
  prefetch: {
    prefetchAll: false,
    defaultStrategy: "hover",
  },
  integrations: [
    starlight({
      title: "Warden",
      description:
        "AI code review CLI that runs deterministic tools, verifies external claims, and uses an LLM only for triage.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/global.css"],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/99Yash/warden" }],
      pagefind: true,
      titleDelimiter: "-",
      components: {
        Head: "./src/components/StarlightHead.astro",
        Header: "./src/components/DocsHeader.astro",
        PageTitle: "./src/components/DocsPageTitle.astro",
      },
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Overview", link: "/docs/", attrs: { "data-astro-prefetch": true } },
            { label: "Install", link: "/docs/install/", attrs: { "data-astro-prefetch": true } },
            {
              label: "Configuration",
              link: "/docs/configuration/",
              attrs: { "data-astro-prefetch": true },
            },
            {
              label: "Reading comments",
              link: "/docs/reading-comments/",
              attrs: { "data-astro-prefetch": true },
            },
            {
              label: "Review pipeline",
              link: "/docs/review/",
              attrs: { "data-astro-prefetch": true },
            },
            { label: "CI usage", link: "/docs/ci/", attrs: { "data-astro-prefetch": true } },
          ],
        },
        {
          label: "Project",
          items: [
            { label: "Examples", link: "/examples/", attrs: { "data-astro-prefetch": true } },
            { label: "Design record", link: "/design/", attrs: { "data-astro-prefetch": true } },
            { label: "Field notes", link: "/notes/", attrs: { "data-astro-prefetch": true } },
          ],
        },
      ],
    }),
  ],
});
