# components/ui

Primitives in the shadcn/ui pattern (Radix through the `radix-ui` package, `class-variance-authority`
for variants, `cn` from `lib/utils.ts`). They are our code: edit them freely.

## Adding a primitive: by hand, not with the CLI

The `shadcn` CLI is **not installed** and there is no `components.json`. Decided in Step 3.1, PR B
(owner, 2026-10-29), because:

- `shadcn add` (4.x) asks which component library to use (Base UI, React Aria or Radix UI) and
  cannot run without a terminal; it hung twice when an agent ran it, even with `style` set in
  `components.json`.
- The CLI writes imports with the `@/` alias. The lint rule `@nx/enforce-module-boundaries` forbids
  an alias inside the same project, so every generated file would need its imports rewritten.

So to add one (a `dialog`, `dropdown-menu`, `tabs`...):

1. Take the source of the component from https://ui.shadcn.com (Radix variant, not Base UI), or
   fetch it with Context7 (`/shadcn-ui/ui`).
2. Create `components/ui/<name>.tsx` with the same shape as the existing ones: function
   components with an explicit `ReactElement` return type, `ComponentProps<...>` for the props,
   relative imports (`../../lib/utils`), no `any`.
3. Keep the colors on the theme tokens of `app/globals.css` (`bg-background`, `text-muted-foreground`,
   ...), never a literal color. Add a token there if one is missing.
4. If it needs a Radix part, import it from `radix-ui` (already a dependency), not from
   `@radix-ui/react-*`.

If someone wants the CLI back, the way is: install `shadcn@4.20.1` as a dev dependency, add a
`components.json` with aliases the lint accepts, run it in a real terminal choosing Radix UI, and
fix the imports. Record that decision in `docs/MVP_TRIM_CHECKLIST.md`, row "Frontend foundation
build details (Step 3.1, PR B)".
