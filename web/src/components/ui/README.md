# UI components

These components and `src/lib/cva.ts` are adapted from the [shadcn-solid registry](https://github.com/hngngn/shadcn-solid/tree/4c75b892148dc81f81167a43756d4ce0fbfe6eae/apps/docs/src/registry), under the MIT license in `web/LICENSE-shadcn-solid`. Like shadcn, the registry provides source code to copy and customize rather than a component package.

The registry targets Solid 1. This app uses Solid 2, so the copied components use Solid 2 props and JSX types, the Solid 2 alpha of Kobalte, Tailwind 4, and the Rosé Pine tokens in `src/ui.css`. Kobalte `2.0.0-alpha.4` declares exact Solid `2.0.0-rc.16` peers; this app resolves one copy of `2.0.0-rc.20` and tests the controls against it. Recheck runtime, keyboard and focus behavior when upgrading either dependency.

Add further components from the registry manually and port them to Solid 2; the published shadcn-solid CLI currently generates Solid 1 components. Keep picker-specific controls and styling intact unless intentionally changing their behavior.
