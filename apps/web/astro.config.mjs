import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://wrdn.beauty",
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
      },
      sidebar: [
        { label: "Home", link: "/", attrs: { "data-astro-prefetch": true } },
        {
          label: "Docs",
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
            { label: "CI usage", link: "/docs/ci/", attrs: { "data-astro-prefetch": true } },
          ],
        },
        { label: "Examples", link: "/examples/", attrs: { "data-astro-prefetch": true } },
        { label: "Design", link: "/design/", attrs: { "data-astro-prefetch": true } },
      ],
    }),
  ],
});
