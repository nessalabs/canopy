#!/usr/bin/env node
// Negative controls run in memory through the same canonical checker as normal
// checks. They never edit a model/page or save deliberately broken evidence.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probes } from "./probes.mjs";

async function main() {
  if (process.argv.length > 2) {
    process.exitCode = 2;
    return {
      ok: false,
      error: "invalid-arguments",
      usage: "node scripts/state-docs/probe-models.mjs",
    };
  }
  if (!process.env.NESSA_DOCS_ROOT) {
    process.exitCode = 2;
    return {
      ok: false,
      error: "renderer-required",
      message:
        "Set NESSA_DOCS_ROOT to a built Nessa Docs checkout; see scripts/state-docs/README.md.",
    };
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const moduleAt = (path) =>
    import(
      pathToFileURL(
        join(resolve(process.env.NESSA_DOCS_ROOT), "dist/server", path),
      ).href
    );
  const [
    { loadCatalog },
    { nodeRepositoryFiles },
    { createCheckerCache },
    { createModelCheckService },
  ] = await Promise.all([
    moduleAt("server/catalog.js"),
    moduleAt("server/files.js"),
    moduleAt("server/model-check/cache.js"),
    moduleAt("server/model-check/service.js"),
  ]);
  const files = nodeRepositoryFiles();
  const catalog = await loadCatalog(files, root);
  if (
    !catalog.rootId ||
    catalog.issues.some((issue) => issue.severity === "error")
  ) {
    process.exitCode = 1;
    return { ok: false, error: "invalid-catalog", issues: catalog.issues };
  }
  const models = new Map(
    [...catalog.documents].filter(([, page]) => page.summary.model),
  );
  const named = new Set(probes.map((probe) => probe.document));
  const missing = [...models.keys()].filter((id) => !named.has(id));
  const unknown = [...named].filter((id) => !models.has(id));
  if (missing.length || unknown.length) {
    process.exitCode = 1;
    return { ok: false, error: "probe-coverage", missing, unknown };
  }
  const checker = createCheckerCache();
  const status = await checker.status();
  if (status.state !== "ready") {
    process.exitCode = 2;
    return { ok: false, checker: status };
  }
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const results = [];
  try {
    const service = createModelCheckService({
      files,
      loadCatalog: (path) => loadCatalog(files, path),
      runtime: () => checker.runtime(),
      status: () => checker.status(),
      install: (signal) => checker.install(signal),
    });
    const inputs = new Map();
    const baselines = [];
    for (const [id, page] of models) {
      const model = page.summary.model;
      const boundary = join(root, "docs/state");
      const [spec, config] = await Promise.all([
        files.readText(join(boundary, model.spec), 1024 * 1024, boundary),
        files.readText(join(boundary, model.config), 1024 * 1024, boundary),
      ]);
      if (spec.kind !== "text" || config.kind !== "text")
        throw new Error(`Model files unreadable for ${id}`);
      inputs.set(id, {
        spec: spec.text,
        config: config.text,
        steps: model.steps,
        nodeIds: [],
        sourceRevision: page.summary.sourceRevision,
        configPath: model.config,
      });
    }
    // A negative control is meaningful only if the same unmodified bytes pass.
    for (const [id, input] of inputs) {
      const run = await service.checkText(input, abort.signal);
      baselines.push({
        document: id,
        state: run.state,
        states: run.result?.states,
        modelDigest: run.result?.modelDigest,
        sourceRevision: input.sourceRevision,
        checker: run.result?.checker,
        date: run.result?.date,
        held: run.result?.held,
      });
      if (run.state !== "passed") {
        process.exitCode = run.state === "broke" ? 1 : 2;
        return {
          ok: false,
          error: "baseline-did-not-pass",
          baselines,
          message: run.message,
        };
      }
      process.stderr.write(`baseline ${id}: passed\n`);
    }
    for (const probe of probes) {
      if (abort.signal.aborted) break;
      let result;
      try {
        const input = inputs.get(probe.document);
        const changed = probe.mutate(input.spec);
        if (changed === input.spec)
          throw new Error(
            "The mutation did not change its expected source guard",
          );
        const run = await service.checkText(
          { ...input, spec: changed },
          abort.signal,
        );
        const broke = run.result?.broke.map((item) => item.rule) ?? [];
        const ok =
          run.state === "broke" &&
          run.result.unchecked.length === 0 &&
          probe.expectedRules.length > 0 &&
          probe.expectedRules.every((rule) => broke.includes(rule));
        result = {
          document: probe.document,
          name: probe.name,
          ok,
          state: run.state,
          expected: probe.expectedRules,
          broke,
          unchecked: run.result?.unchecked ?? [],
          counterexamples: run.result?.broke ?? [],
          modelDigest: run.result?.modelDigest,
          ...(ok ? {} : { message: run.message }),
        };
      } catch (error) {
        result = {
          document: probe.document,
          name: probe.name,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      results.push(result);
      process.stderr.write(
        `${result.ok ? "caught" : "FAIL"} ${probe.document}: ${probe.name}\n`,
      );
    }
    const ok =
      results.length === probes.length && results.every((result) => result.ok);
    process.exitCode = ok ? 0 : abort.signal.aborted ? 2 : 1;
    return {
      ok,
      checker: status.version,
      date: new Date().toISOString(),
      models: models.size,
      baselines,
      probes: probes.length,
      completed: results.length,
      results,
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
    `${JSON.stringify({ ok: false, error: "probe-unavailable", message: error instanceof Error ? error.message : String(error) })}\n`,
  );
}
