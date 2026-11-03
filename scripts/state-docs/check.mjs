#!/usr/bin/env node
// Developer composition only. Nessa Docs owns parsing, validation, TLC pins,
// bounded execution and saved-result serialization; do not copy those rules here.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const usage =
  "node scripts/state-docs/check.mjs [--models [--install] [--write]]";
const args = process.argv.slice(2);
const allowed = new Set(["--models", "--install", "--write"]);
const models = args.includes("--models");
const install = args.includes("--install");
const write = args.includes("--write");

async function main() {
  if (args.length === 1 && args[0] === "--help") return { ok: true, usage };
  if (
    args.some((arg) => !allowed.has(arg)) ||
    new Set(args).size !== args.length ||
    (!models && (install || write))
  ) {
    process.exitCode = 2;
    return { ok: false, error: "invalid-arguments", usage };
  }
  const checkout = process.env.NESSA_DOCS_ROOT;
  if (!checkout) {
    process.exitCode = 2;
    return {
      ok: false,
      error: "renderer-required",
      message:
        "Set NESSA_DOCS_ROOT to a built nessalabs/nessa-docs checkout. See scripts/state-docs/README.md.",
    };
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const moduleAt = (path) =>
    import(pathToFileURL(join(resolve(checkout), "dist/server", path)).href);
  const [{ loadCatalog }, { nodeRepositoryFiles }] = await Promise.all([
    moduleAt("server/catalog.js"),
    moduleAt("server/files.js"),
  ]);
  const files = nodeRepositoryFiles();
  const catalog = await loadCatalog(files, root);
  const result = {
    ok:
      catalog.rootId !== null &&
      catalog.issues.every((issue) => issue.severity !== "error"),
    documents: catalog.documents.size,
    issues: catalog.issues,
  };
  if (!result.ok) {
    process.exitCode = 1;
    return result;
  }
  if (!models) return result;
  const pages = [...catalog.documents.values()].filter(
    (page) => page.summary.model,
  );
  if (pages.length === 0) {
    process.exitCode = 2;
    return { ...result, ok: false, error: "no-models", models: [] };
  }
  const [
    { createCheckerCache },
    { createModelCheckService },
    { diagramNodeIds },
    { writeModelCheckFile },
  ] = await Promise.all([
    moduleAt("server/model-check/cache.js"),
    moduleAt("server/model-check/service.js"),
    moduleAt("server/model-check/nodes.js"),
    moduleAt("server/model-check/record.js"),
  ]);
  const checker = createCheckerCache();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const status = install
      ? await checker.install(abort.signal)
      : await checker.status();
    if (status.state !== "ready") {
      process.exitCode = 2;
      return { ...result, ok: false, checker: status, models: [] };
    }
    const service = createModelCheckService({
      files,
      loadCatalog: (path) => loadCatalog(files, path),
      runtime: () => checker.runtime(),
      status: () => checker.status(),
      install: (signal) => checker.install(signal),
    });
    const runs = [];
    for (const page of pages) {
      const { model, sourceRevision, id, file } = page.summary;
      let run;
      try {
        const boundary = join(root, "docs/state");
        const [spec, config] = await Promise.all([
          files.readText(join(boundary, model.spec), 1024 * 1024, boundary),
          files.readText(join(boundary, model.config), 1024 * 1024, boundary),
        ]);
        if (spec.kind !== "text" || config.kind !== "text")
          throw new Error(`Cannot read the linked model for ${id}.`);
        run = await service.checkText(
          {
            spec: spec.text,
            config: config.text,
            steps: model.steps,
            nodeIds: diagramNodeIds(page.body),
            sourceRevision,
            configPath: model.config,
          },
          abort.signal,
        );
        if (write && run.result)
          await writeModelCheckFile(root, file, run.result);
        runs.push({
          document: id,
          state: run.state,
          message: run.message,
          saved: Boolean(write && run.result),
          ...(run.result ? { result: run.result } : {}),
        });
      } catch (error) {
        runs.push({
          document: id,
          state: "failed",
          saved: false,
          message: error instanceof Error ? error.message : String(error),
          ...(run?.result ? { result: run.result } : {}),
        });
      }
      if (abort.signal.aborted) break;
    }
    const broken = runs.some((run) => run.result?.broke.length > 0);
    const ok =
      runs.length === pages.length &&
      runs.every((run) => run.state === "passed");
    process.exitCode = broken ? 1 : ok ? 0 : 2;
    return {
      ...result,
      ok,
      models: runs,
      saved: runs.filter((run) => run.saved).map((run) => run.document),
    };
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error) {
  process.exitCode = 2;
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: "check-unavailable", message: error instanceof Error ? error.message : String(error) })}\n`,
  );
}
