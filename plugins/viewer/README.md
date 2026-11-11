# Viewer plugin

`@kb-labs/viewer` registers the Viewer REST routes and Studio page. The page browses the current project's architecture tree, reads linked Markdown and diagrams, previews PDFs, and converts DOC/DOCX files to PDF when LibreOffice is available in the Studio runtime. ZIP import and export use project-local managed storage.

The routes are mounted under `/api/v1/plugins/viewer`. For example, `GET /api/v1/plugins/viewer/index?source=workspace` reads the architecture package under `docs/architecture`.

The plugin is one package and uses `@kb-labs/sdk` for plugin registration. Build it with `pnpm --filter @kb-labs/viewer build`.
