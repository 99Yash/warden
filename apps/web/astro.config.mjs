import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://wrdn.beauty",
  markdown: {
    smartypants: false,
    // Code blocks are dark in both themes, like the code sample on the home page.
    shikiConfig: { theme: "github-dark-default" },
  },
  devToolbar: {
    enabled: false,
  },
  prefetch: {
    prefetchAll: false,
    defaultStrategy: "hover",
  },
});
